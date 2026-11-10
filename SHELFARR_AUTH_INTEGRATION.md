# Shelfarr Unified BookOrbit Authentication Integration

This document details the configuration and architectural extensions implemented to enable BookOrbit credentials to be used directly on Shelfarr's login screen at `https://dl.drkhn.site`.

---

## 1. Overview & Objective

Shelfarr was deployed as an isolated book acquisition companion for BookOrbit on `https://dl.drkhn.site`. By default, Shelfarr manages its own isolated SQLite user database and password digests.

The objective was to unify the authentication experience so that users (`drkhn`, `ladin`, or any future BookOrbit account) can enter their existing BookOrbit credentials into Shelfarr's standard web login screen (`https://dl.drkhn.site/session/new`), without external SSO redirects, while preserving:
- Native role parity (BookOrbit superusers receive Shelfarr `admin` rights; standard users receive `user` rights).
- Strict API token isolation (preventing an admin user's MCP reader tokens from inadvertently inheriting cross-user admin privileges).
- Resilient local fallback (preserving emergency local access for recovery accounts like `acquisition_admin`).
- Offline/cache capability (syncing local BCrypt hashes in Shelfarr upon login).

---

## 2. Architecture & Authentication Flow

```
                                      +---------------------------------------------+
                                      |             User Browser                    |
                                      |   https://dl.drkhn.site/session/new         |
                                      +----------------------+----------------------+
                                                             |
                                         POST /session (username, password)
                                                             |
                                                             v
                                      +---------------------------------------------+
                                      |                  Caddy                      |
                                      |     Reverse Proxy -> 127.0.0.1:5056         |
                                      +----------------------+----------------------+
                                                             |
                                                             v
                                      +---------------------------------------------+
                                      |      Shelfarr (Rails 8 Application)         |
                                      |    SessionsController#create (Prepended)    |
                                      +----------------------+----------------------+
                                                             |
                              +------------------------------+------------------------------+
                              |                                                             |
                 1. Call BookorbitAuthService                                 2. Fallback (super)
                              |                                                             |
                              v                                                             v
               +-----------------------------+                               +-----------------------------+
               |  BookOrbit HTTP Auth API    |                               |    Shelfarr Local SQLite    |
               |  http://bookorbit-app:3000  |                               |    User.authenticate(...)   |
               |   /api/v1/auth/login        |                               +-----------------------------+
               +--------------+--------------+
                              |
                     200 OK / 401 Unauthorized
                              |
                              v
               +-----------------------------+
               |  BookorbitAuthService       |
               |  - sync_user (name, role)   |
               |  - sync password_digest     |
               |  - issue MCP APIToken       |
               |  - complete_login(user)     |
               +-----------------------------+
```

---

## 3. Code Implementation Details

The implementation extends Shelfarr non-invasively through its existing initializer mount at `deployment/shelfarr/bookorbit_mcp.rb`:

### A. BookOrbit Authentication Service (`BookorbitAuthService`)
- **Dual Endpoints**: Queries `http://bookorbit-app:3000/api/v1/auth/login` directly over the internal Docker network. Automatically falls back to `https://books.drkhn.site/api/v1/auth/login` if the internal endpoint is unreachable.
- **Client IP Forwarding**: Forwards `request.remote_ip` via the `X-Forwarded-For` HTTP header so BookOrbit rate limiting and audit logs attribute activity to the true remote client.
- **Credential Validation**: Validates HTTP response status (`200 OK`) and asserts `active: true` on the returned user payload.

### B. User Synchronization (`BookorbitAuthService.sync_user`)
- **Matching Priority**:
  1. Canonical lowercase username (`drkhn`, `ladin`).
  2. Linked OIDC identity (`oidc_provider: 'bookorbit'`, `oidc_uid: native_id`).
  3. Pre-existing bootstrap reader usernames (`reader_#{native_id}`).
- **Attribute Synchronization**:
  - Updates display name (`Dorukhan`, `Ladin`).
  - Sets `oidc_provider = "bookorbit"` and `oidc_uid = native_id` (this marks the user as an OIDC user in Shelfarr, bypassing Shelfarr's local password complexity validations and ensuring custom BookOrbit passwords are accepted).
  - Synchronizes the role: `isSuperuser ? :admin : :user`.
  - Hashes and saves the newly verified password locally into `password_digest` for offline resilience.
  - Ensures an active `BookOrbit MCP` API token exists for the account.

### C. Controller Extension (`BookorbitSessionsExtension`)
- Prepended to `SessionsController`.
- Intercepts `POST /session`:
  - If BookOrbit authentication succeeds: syncs user, checks lockout status, handles optional 2FA/OTP if enabled, and invokes `complete_login(user)`.
  - If BookOrbit authentication fails or credentials belong to a local-only user: invokes `super` to execute default Rails authentication and error handling.

### D. Strict API Token Scope Isolation (`BookorbitCurrentPatch`)
- Shelfarr's default `Current#api_admin?` checked `api_user&.admin?`. If a user had an admin role, any API token issued to that user inherited administrative privileges even if the token's scopes were limited.
- Prepend-patched `Current#api_admin?` to enforce:
  ```ruby
  def api_admin?
    return true if legacy_api_token_authenticated
    if api_token
      api_token.has_scope?("requests:admin")
    else
      api_user&.admin?
    end
  end
  ```
- **Result**: In the web UI, `drkhn` has full administrator privileges (`/admin/*`). In MCP automation, `drkhn`'s reader token (scoped to `search:read requests:read requests:write`) is strictly confined to his own requests.

---

## 4. Docker & Network Configuration

In `deployment/shelfarr/compose.yml`:
- Attached `shelfarr` to the existing external bridge network `bookorbit_default`.
- Configured environment variable `BOOKORBIT_AUTH_URL: http://bookorbit-app:3000/api/v1/auth/login`.
- Preserved ingress binding on `127.0.0.1:5056` mapped via Caddy reverse proxy to `dl.drkhn.site`.

---

## 5. Deployed Account Mappings

| Shelfarr ID | Username | Display Name | Shelfarr Role | BookOrbit Native ID | Linked MCP Scope |
|:---:|:---:|:---:|:---:|:---:|:---:|
| `1` | `acquisition_admin` | Acquisition administrator | Admin | — (Local Fallback) | — |
| `2` | `ladin` | Ladin | User (Reader) | `2` | `ef9f014337e3...` |
| `3` | `drkhn` | Dorukhan | Admin | `1` | `562f9c9e4927...` |

---

## 6. Verification & Test Evidence

1. **Invalid Login Rejection**:
   - Submitting non-existent usernames or bad passwords fails BookOrbit auth, falls back to local auth, fails, and returns HTTP 200 with flash alert: `"Invalid username or password."`
2. **Local Recovery Login**:
   - Submitting `acquisition_admin` with its stored recovery password bypasses BookOrbit and signs in successfully with a 302 redirect to `/` and valid `session_id` cookies.
3. **MCP Token Scope Verification**:
   - Queried `http://127.0.0.1:5056/api/v1/requests` using the bearer tokens in `mcp-accounts.json`:
     - Token for `userId: 2` (`ladin`): returned only Ladin's requests (`requests_count=1`).
     - Token for `userId: 3` (`drkhn`): returned only Dorukhan's requests (`requests_count=1`), proving the admin patch successfully prevents token privilege escalation.
4. **Automated Test Suite**:
   - Ran `npm test` against the complete BookOrbit MCP test suite (118/118 passing tests).
