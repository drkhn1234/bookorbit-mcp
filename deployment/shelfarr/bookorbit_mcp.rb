# frozen_string_literal: true

# Narrow, pinned-version extension. Mount read-only into Shelfarr's initializers.
# Uses Shelfarr's own bearer-token scopes and request-owner authorization.
Rails.application.config.to_prepare do
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
