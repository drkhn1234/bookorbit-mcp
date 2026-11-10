# frozen_string_literal: true

require "net/http"
require "json"
require "uri"

# BookOrbit External Authentication & User Synchronization Service
module BookorbitAuthService
  class << self
    def auth_urls
      primary = ENV["BOOKORBIT_AUTH_URL"].presence || "http://bookorbit-app:3000/api/v1/auth/login"
      fallback = "https://books.drkhn.site/api/v1/auth/login"
      [primary, fallback].uniq.compact
    end

    def authenticate(username, password, client_ip: nil)
      return nil if username.blank? || password.blank?

      payload = JSON.generate({ username: username.to_s.strip, password: password.to_s })

      auth_urls.each do |url_str|
        uri = URI(url_str)
        http = Net::HTTP.new(uri.host, uri.port)
        http.use_ssl = (uri.scheme == "https")
        http.open_timeout = 4
        http.read_timeout = 6

        req = Net::HTTP::Post.new(uri.request_uri)
        req["Content-Type"] = "application/json"
        req["X-Forwarded-For"] = client_ip if client_ip.present?
        req.body = payload

        begin
          res = http.request(req)
          if res.code == "200"
            data = JSON.parse(res.body)
            user_info = data["user"]
            if user_info && user_info["active"] != false
              return user_info
            end
            return nil
          elsif res.code == "401" || res.code == "403"
            return nil
          end
        rescue StandardError => e
          Rails.logger.warn("[BookOrbit Auth] Failed connecting to #{url_str}: #{e.class} - #{e.message}")
          next
        end
      end

      nil
    end

    def sync_user(bookorbit_user, password)
      native_id = bookorbit_user["id"].to_s
      canonical_username = bookorbit_user["username"].to_s.strip.downcase
      display_name = bookorbit_user["name"].to_s.strip.presence || canonical_username
      is_superuser = !!bookorbit_user["isSuperuser"]

      # 1. Match by canonical username
      user = User.active.find_by(username: canonical_username)

      # 2. Match by linked oidc identity
      user ||= User.active.find_by(oidc_provider: "bookorbit", oidc_uid: native_id)

      # 3. Match by bootstrap reader username
      user ||= User.active.find_by(username: "reader_#{native_id}")

      if user
        user.username = canonical_username
        user.name = display_name
        user.oidc_provider = "bookorbit"
        user.oidc_uid = native_id
        user.role = is_superuser ? :admin : user.role
        user.password = password
        user.password_confirmation = password
        user.save!
      else
        user = User.create!(
          username: canonical_username,
          name: display_name,
          role: is_superuser ? :admin : :user,
          oidc_provider: "bookorbit",
          oidc_uid: native_id,
          password: password,
          password_confirmation: password
        )
      end

      # Ensure an active MCP token exists
      unless user.api_tokens.where(name: "BookOrbit MCP").active.exists?
        APIToken.issue!(name: "BookOrbit MCP", user: user, scopes: %w[search:read requests:read requests:write])
      end

      user
    end
  end
end

module BookorbitSessionsExtension
  def create
    raw_username = params[:username]&.strip&.downcase
    password = params[:password]

    if raw_username.present? && password.present?
      bookorbit_user = BookorbitAuthService.authenticate(raw_username, password, client_ip: request.remote_ip)

      if bookorbit_user
        user = BookorbitAuthService.sync_user(bookorbit_user, password)

        if user.locked?
          log_security_event("login.blocked_locked", user, raw_username)
          redirect_to new_session_path, alert: "Account is locked. Try again in #{user.unlock_in_words}."
          return
        end

        if user.otp_enabled?
          session[:pending_user_id] = user.id
          redirect_to verify_otp_session_path
        else
          complete_login(user)
        end
        return
      end
    end

    super
  end
end

# Strict API token scope patch: keep reader API tokens isolated even if the user has an admin role in the UI
module BookorbitCurrentPatch
  def api_admin?
    return true if legacy_api_token_authenticated
    if api_token
      api_token.has_scope?("requests:admin")
    else
      api_user&.admin?
    end
  end
end

# Pinned-version extensions for BookOrbit MCP and Authentication
Rails.application.config.to_prepare do
  SessionsController.prepend(BookorbitSessionsExtension) unless SessionsController.ancestors.include?(BookorbitSessionsExtension)
  Current.prepend(BookorbitCurrentPatch) unless Current.ancestors.include?(BookorbitCurrentPatch)

  class API::V1::BookorbitDeliveriesController < API::V1::ApplicationController
    before_action -> { require_scope!("requests:read") }

    def retry_owned
      return head(:forbidden) unless Current.api_scope?("requests:write")
      scope = Current.api_admin? ? Request.all : Request.for_user(Current.api_user)
      acquisition = scope.find(params[:id])
      return head(:conflict) unless acquisition.can_retry?
      acquisition.retry_now!
      render json: { status: acquisition.reload.status }
    rescue ActiveRecord::RecordNotFound
      head :not_found
    end

    def show
      scope = Current.api_admin? ? Request.all : Request.for_user(Current.api_user)
      acquisition = scope.includes(:book).find(params[:id])
      return render(json: { errors: ["Request not completed"] }, status: :conflict) unless acquisition.completed?

      root = File.realpath(ENV.fetch("BOOKORBIT_DELIVERY_ROOT", "/ebooks"))
      source = acquisition.book.file_path.to_s
      path = File.realpath(source)
      # Only standalone EPUB/PDF, inside acquisition storage; no caller paths.
      if File.directory?(path)
        files = Dir.glob(File.join(path, "**", "*"))
          .select { |p| File.file?(p) && %w[.epub .pdf].include?(File.extname(p).downcase) }
        return render(json: { errors: ["Delivery needs one EPUB or PDF"] }, status: :unprocessable_entity) unless files.one?
        path = File.realpath(files.first)
      end
      return head(:forbidden) unless path.start_with?(root + File::SEPARATOR)
      return head(:unprocessable_entity) unless %w[.epub .pdf].include?(File.extname(path).downcase)
      return head(:payload_too_large) if File.size(path) > 128 * 1024 * 1024

      response.headers["Cache-Control"] = "no-store"
      response.headers["X-Content-Type-Options"] = "nosniff"
      send_file path, disposition: "attachment", filename: "acquisition-#{acquisition.id}#{File.extname(path).downcase}"
    rescue ActiveRecord::RecordNotFound, Errno::ENOENT
      head :not_found
    end
  end

  class API::V1::BookorbitResearchController < API::V1::ApplicationController
    before_action -> { require_scope!("search:read") }

    def show
      work_id = params[:work_id].to_s
      return head(:bad_request) unless work_id.match?(/\A(?:openlibrary|google_books|hardcover):[A-Za-z0-9_-]{1,100}\z/)
      details = MetadataService.book_details(work_id)
      render json: { work_id: work_id, title: details.title, author: details.author,
        description: details.description.to_s.truncate(12_000), source_url: details.source_url,
        review_text_available: false }
    rescue StandardError
      render json: { errors: ["Metadata details unavailable"] }, status: :bad_gateway
    end
  end
end

Rails.application.routes.append do
  get "/api/v1/requests/:id/artifact", to: "api/v1/bookorbit_deliveries#show"
  post "/api/v1/requests/:id/retry_owned", to: "api/v1/bookorbit_deliveries#retry_owned"
  get "/api/v1/book_research", to: "api/v1/bookorbit_research#show"
end
