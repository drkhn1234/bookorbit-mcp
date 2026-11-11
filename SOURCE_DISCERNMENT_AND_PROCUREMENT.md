# Source Discernment, FlareSolverr & Shelfarr Procurement Integration

This document details the architectural extensions, services, and MCP tools implemented to enable:
1. **BookOrbit Unified Authentication** on Shelfarr's login screen (`https://dl.drkhn.site`).
2. **FlareSolverr Service Deployment** for Cloudflare/bot challenge resolution on acquisition sources.
3. **Source Discernment & Acquisition Provenance** allowing AI agents and users to inspect, learn about, and trace where books and releases originate across discovery, research, release selection, and job status.

---

## 1. Context & Motivation

Shelfarr serves as an automated book search, indexing, and acquisition backend, integrated with BookOrbit as the catalog, permission, and library storage authority.

Three operational and intelligence gaps were identified:
1. **Authentication Friction**: Shelfarr maintained isolated user records, requiring duplicate credentials and manual account synchronization.
2. **Anti-Bot / DDoS Challenge Blocks**: Searching or downloading from certain shadow libraries and trackers (e.g. Anna's Archive mirrors) encountered Cloudflare Turnstile/challenge pages.
3. **Source Opacity for AI Agents**: While Shelfarr searched providers internally, the MCP interface previously returned releases and candidates with minimal provenance. An AI client could not discern:
   - What acquisition sources (Project Gutenberg, Anna's Archive, Z-Library, torrent/usenet indexers) were configured or active.
   - What download protocols (`direct` HTTP, `torrent`, `usenet`) were used by each candidate release.
   - What metadata provider (Open Library, Google Books, Hardcover, Comic Vine) contributed bibliographic information or descriptions.
   - Which specific provider and tracker fulfilled a downloaded and imported book.

---

## 2. FlareSolverr Deployment

FlareSolverr is deployed alongside Shelfarr on the Oracle VPS to act as a proxy that solves Cloudflare DDoS and browser verification challenges for configured download clients.

### Compose Configuration (`deployment/shelfarr/compose.yml`)
```yaml
services:
  flaresolverr:
    image: ghcr.io/flaresolverr/flaresolverr:latest
    restart: unless-stopped
    ports:
      - "127.0.0.1:8191:8191"
    environment:
      - LOG_LEVEL=${FLARESOLVERR_LOG_LEVEL:-info}
      - LOG_HTML=${FLARESOLVERR_LOG_HTML:-false}
      - CAPTCHA_SOLVER=none
      - TZ=UTC
    networks:
      - default
    mem_limit: 1024m
    cpus: "0.5"
    healthcheck:
      test: ["CMD", "curl", "-fsS", "http://localhost:8191/"]
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 30s
```

### Integration Status
- Port: `127.0.0.1:8191`
- Shelfarr Integration: Tested via `FlaresolverrClient.test_connection` -> `{"status": "ok", "message": "FlareSolverr is ready!"}`.

---

## 3. Shelfarr Unified Authentication & Scope Hardening

Implemented in `deployment/shelfarr/bookorbit_mcp.rb`:
- **`BookorbitSessionsExtension`**: Prepended to `SessionsController#create`. Intercepts login submissions, authenticates credentials directly against BookOrbit (`POST http://bookorbit-app:3000/api/v1/auth/login`), and synchronizes users, roles (superusers map to Shelfarr `admin`, standard readers to `user`), and local password hashes.
- **`BookorbitCurrentPatch`**: Strictly guards `Current#api_admin?`. Even if an account has web UI admin rights, its MCP API tokens are constrained to non-admin reader privileges unless the token explicitly carries the `requests:admin` scope.
- Full details: See [`SHELFARR_AUTH_INTEGRATION.md`](SHELFARR_AUTH_INTEGRATION.md).

---

## 4. Source Discernment & Acquisition Provenance

### 4.1 Backend Rails Extensions (`deployment/shelfarr/bookorbit_mcp.rb`)

1. **`API::V1::BookorbitSourcesController` (`GET /api/v1/sources`)**:
   Exposes all configured acquisition and metadata sources to authenticated API clients:
   - **`acquisition_sources`**:
     - *Project Gutenberg*: Public domain direct OPDS catalog and direct HTTP downloads (`ebook`, `direct`).
     - *Anna's Archive*: Open shadow library direct download mirrors (`ebook`, `comicbook`, `direct`).
     - *Z-Library*: Direct ebook downloads via Remix API (`ebook`, `direct`).
     - *LibriVox*: Public domain audiobooks (`audiobook`, `direct`).
     - *Prowlarr / Jackett*: Torrent and Usenet indexers (`ebook`, `audiobook`, `comicbook`, `torrent`).
     - *Custom Providers*: External custom acquisition providers from `AcquisitionProvider` table.
   - **`metadata_sources`**:
     - Open Library, Google Books, Hardcover, Comic Vine with priority ranking, health status, and rate-limiting flags.
   - **`store_providers`**:
     - Commercial offers (eBooks.com) and market configuration.
   - **`download_preferences`**:
     - Protocol priority order (e.g. `["torrent", "usenet", "direct"]`).

2. **`BookorbitRequestsExtension` (Prepended to `API::V1::RequestsController`)**:
   - `search_result_payload(result)`: Enriches every release candidate with:
     - `source_name`: Display name (e.g. `"Project Gutenberg"`, `"Anna's Archive"`, `"Z-Library"`, or tracker name).
     - `protocol`: Download type (`direct`, `torrent`, `usenet`).
     - `format`: Primary file extension (`epub`, `pdf`, `m4b`).
     - `detected_extensions`: Array of detected formats.
     - `size_human`: Human-readable size (e.g. `"2.4 MB"`).
     - `confidence_level`: `"high"`, `"medium"`, or `"low"`.
     - `language_name`: Normalized language display name.
     - `info_url`: URL pointing to the release page / source item.
     - `acquisition_provider_name`: Name of custom provider if applicable.
   - `request_payload(request)`: Enriches request data with `selected_release` provenance details.

3. **`BookorbitResearchController#show` (`GET /api/v1/book_research`)**:
   - Returns bibliographic source provenance: `source`, `source_name`, `source_url`, `source_attribution`, `cover_url`, and publication `year`.

---

### 4.2 BookOrbit MCP Client Tools (`src/procurement.ts`)

The procurement suite now provides six specialized tools:

| Tool | Purpose | Source Discernment Capabilities |
| --- | --- | --- |
| `get_procurement_sources` | Inspect configured sources & providers | Lists all direct acquisition sources, torrent indexers, metadata providers, status/rate-limits, and protocol preferences. |
| `discover_books` | External catalog search + owned match | Returns candidate works alongside `sourcesSummary` summarizing the bibliographic sources providing candidates. |
| `research_book` | Deep work research & ratings | Returns `sourceProvenance` (authoritative source name, canonical URL, attribution) plus BookOrbit provider enrichment. |
| `procure_book` | Preview & queue ebook acquisition | Binds account, library upload rights, and intent; preserves release provenance. |
| `find_book_releases` | Inspect available releases | Exposes enriched releases (`sourceName`, `indexer`, `protocol`, `format`, `sizeHuman`, `confidenceLevel`, `infoUrl`) and `sourcesSummary`. Selecting a result (`resultId`) records provenance to the job. |
| `procurement_status` | Track jobs & import completed files | Reports release provenance (`source`, `sourceName`, `protocol`, `format`, `releaseTitle`) across status polling, verification, and native BookOrbit library import. |

### 4.3 Data Structures

#### `Job` Provenance Fields
```typescript
type Job = {
  id: string;
  key: string;
  createdAt: string;
  workId: string;
  title: string;
  author: string;
  language: string;
  libraryId: number;
  collectionId?: number;
  requestId?: number;
  state: string;
  bookId?: number;
  sha256?: string;
  error?: string;
  collectionAdded?: boolean;
  allowUnverifiedMetadata?: boolean;
  verification?: { metadataMatch: string; editionVerified: boolean };
  // Source Discernment & Provenance
  source?: string;           // e.g. "gutenberg", "anna_archive", "zlibrary"
  sourceName?: string;       // e.g. "Project Gutenberg", "Anna's Archive"
  indexer?: string;          // tracker/indexer name if applicable
  protocol?: string;         // "direct", "torrent", "usenet"
  format?: string;           // "epub", "pdf"
  releaseTitle?: string;     // title of the chosen release
};
```

---

## 5. Verification & Test Evidence

### 5.1 Unit Tests
Run locally in `/home/drkhn/Projects/bookorbit-mcp`:
```bash
npm test
```
- **Total Tests**: 119 passed, 0 failed.
- **Coverage**: Includes unit testing for `sources()`, `discover()` sources summary, `research()` source provenance, `releases()` release mapping and job provenance recording, and `status()` remote release tracking.

### 5.2 Live Integration Testing
Verified against live services on the Oracle VPS (`https://dl.drkhn.site` / `http://127.0.0.1:5056`):
- `GET /api/v1/sources` -> HTTP 200 with acquisition sources (Gutenberg, Anna's Archive, Z-Library, LibriVox), metadata sources (Hardcover, Open Library, Google Books, Comic Vine), and store offers.
- `GET /api/v1/book_research?work_id=openlibrary:OL102749W` -> HTTP 200 with title, description, and source provenance (`source: "openlibrary"`, `source_name: "Open Library"`, `source_url: "https://openlibrary.org/works/OL102749W"`).
- `GET /api/v1/requests/4/search_results` -> HTTP 200 with enriched release attributes (`source_name: "Project Gutenberg"`, `protocol: "direct"`, `format: "epub"`, `confidence_level: "high"`).
- `ProcurementService.sources()` and `ProcurementService.research()` tested live from Node.js on the VPS.

---

## 6. Deployment & Service Management

### 6.1 VPS Service Details
- **Host**: Oracle VPS (`oracle`, `100.74.111.119`)
- **Systemd Service**: `bookorbit-mcp.service` on port `3001`
- **Active Release Directory**: `/home/ubuntu/services/bookorbit-mcp-releases/22983d4076873659d767b48eff256b814307a316`
- **Shelfarr Container**: `shelfarr-stage-shelfarr-1` (`127.0.0.1:5056` -> `https://dl.drkhn.site`)
- **FlareSolverr Container**: `shelfarr-stage-flaresolverr-1` (`127.0.0.1:8191`)

### 6.2 Rollback Instructions

If a rollback is ever needed:

1. **Rollback Git Repository**:
   ```bash
   cd ~/Projects/bookorbit-mcp
   # To rewind to the state before source discernment:
   git checkout 71b56a6a7928c3db3429d2aebc4f34fcb7b21f11
   # Or to the original state before Shelfarr auth:
   git checkout 5b89634f23e7eadf6530f1d859e32d7b3df2194e
   ```

2. **Rollback VPS MCP Service**:
   ```bash
   ssh oracle
   # Switch systemd drop-in back to previous release:
   sudo sed -i 's/22983d4076873659d767b48eff256b814307a316/5b89634f23e7eadf6530f1d859e32d7b3df2194e/g' /etc/systemd/system/bookorbit-mcp.service.d/knowledge.conf
   sudo systemctl daemon-reload
   sudo systemctl restart bookorbit-mcp.service
   ```

3. **Rollback Shelfarr Initializer**:
   ```bash
   ssh oracle
   cd /home/ubuntu/services/shelfarr-stage
   # The previous initializer backup or git commit can be restored
   docker compose restart shelfarr
   ```

---

## 7. Git Commit Log

All changes are committed and pushed to `origin/dev/bookorbit-knowledge-automation`:

- [`22983d4`](https://github.com/drkhn1234/bookorbit-mcp/commit/22983d4076873659d767b48eff256b814307a316) — `feat(procurement): add source discernment tools and release provenance tracking`
- [`71b56a6`](https://github.com/drkhn1234/bookorbit-mcp/commit/71b56a6a7928c3db3429d2aebc4f34fcb7b21f11) — `feat(shelfarr): deploy FlareSolverr service for DDoS and bot challenge resolution`
- [`230843b`](https://github.com/drkhn1234/bookorbit-mcp/commit/230843bdfc034c27333bfd8e923a2e9aad42825b) — `docs: add SHELFARR_AUTH_INTEGRATION.md documenting BookOrbit credential authentication`
- [`7f815c1`](https://github.com/drkhn1234/bookorbit-mcp/commit/7f815c1b012fe0ee6b920e1c8d41701985a24557) — `feat(shelfarr): unify login screen authentication with BookOrbit credentials`
