# Shelfarr acquisition through MCP

The optional acquisition integration adds six tools to the existing 51 tools.
Enable it with `SHELFARR_CONFIG_FILE`; without that setting the existing server is
unchanged. BookOrbit remains the catalog, authorization and final library-storage
authority. Shelfarr owns source search, release selection, downloads and its queue.
Existing Voyage/LanceDB indexing handles imported books.

| Tool | Purpose |
| --- | --- |
| `get_procurement_sources` | Inspect configured and available acquisition sources (e.g. Gutenberg, Anna's Archive, Z-Library, indexers), metadata providers (Open Library, Google Books, Hardcover) and commercial store offers. |
| `discover_books` | External catalog search plus matches from only your accessible BookOrbit catalog, surfacing candidate metadata source provenance. |
| `research_book` | Descriptions, source links, provider provenance and configured native metadata-provider candidates, including available aggregate ratings. |
| `procure_book` | Preview then queue a selected ebook into an explicit authorized library, optionally an owned collection. |
| `find_book_releases` | Inspect available releases with source provenance (provider/indexer, download protocol, format, size, quality score) and purchase offers; optionally select a result to download. |
| `procurement_status` | Track job state, source provenance of chosen releases, completed-file import, cancellation and hash-verified reconciliation. |

Example client instructions:

> Find books about geometric approaches to electromagnetism. Check my accessible
> library, research descriptions and ratings, and explain the best matches with
> sources. Do not request anything yet.

> What sources does the system have configured to discover and download books?
> Explain where public domain vs copyrighted releases are obtained.

> Request the chosen work as an English ebook into library 12, then show available
> releases. Explain where each release originates (Gutenberg, shadow library, or torrent tracker)
> and its protocol and format. Use the existing “Exam preparation” collection if I own it.

The AI client interprets conceptual questions and may translate them into several
catalog searches. External discovery is not semantic full-text search of books you
do not possess. Individual Goodreads/Amazon comments are not fetched by this
integration: use client web research where available. Metadata candidates are not
proof of edition identity; preserve source/ISBN/author and rating provenance.
Missing ratings or blocked providers are gaps, never fabricated reviews or zeroes.

### Source Discernment & Provenance

The AI can discern source information across all procurement stages:

- **Source Overview (`get_procurement_sources`)**:
  - Acquisition sources: Direct downloads (Project Gutenberg for public domain OPDS, Anna's Archive, Z-Library, LibriVox audiobooks), BitTorrent / Usenet indexers (Prowlarr, Jackett), and custom external providers. Exposes protocols (`direct`, `torrent`, `usenet`), enabled status, and supported book types (`ebook`, `audiobook`, `comicbook`).
  - Metadata providers: Hardcover, Open Library, Google Books, and Comic Vine. Exposes priority ranking, rate-limiting status, and identifier prefixes (e.g., `openlibrary:`, `google_books:`, `hardcover:`).
  - Commercial storefronts: DRM-free store offers (eBooks.com, etc.).
  - Download preferences: Configured order of preferred protocols (e.g., `["torrent", "usenet", "direct"]`).

- **Discovery Provenance (`discover_books`)**:
  - Returns `sourcesSummary` summarizing the bibliographic sources contributing to candidate results (e.g., `["Open Library", "Hardcover"]`).
  - Each candidate carries `source`, `source_name`, `source_url`, and `sources` array for multi-provider aggregated works.

- **Research Provenance (`research_book`)**:
  - Exposes `sourceProvenance` with the authoritative metadata source name, canonical URL, and provider attribution.
  - Returns candidate metadata enriched by configured BookOrbit providers with respective provider keys and source links.

- **Release Provenance (`find_book_releases`)**:
  - Each release item includes `source` (provider identifier), `sourceName` (display name, e.g. "Project Gutenberg", "Anna's Archive", "Z-Library", or tracker name), `indexer` (originating tracker/indexer), `protocol` (`direct`, `torrent`, `usenet`), `format` (file extension like `epub` or `pdf`), `detectedExtensions`, `sizeBytes`, `sizeHuman` (e.g. `2.0 MB`), `confidenceScore`, `confidenceLevel` (`high`, `medium`, `low`), and `infoUrl`.
  - Returns `sourcesSummary` listing all distinct sources and protocols found for the work.

- **Job Tracking & Provenance (`procurement_status`)**:
  - Persists and surfaces the chosen release source (`source`, `sourceName`, `indexer`, `protocol`, `format`, `releaseTitle`) across status polling and import.
  - When imported into BookOrbit, the source provenance is retained alongside the verified artifact hash and destination library.

## Configuration and deployment

`deployment/shelfarr/compose.yml` provides an isolated Shelfarr deployment.
Enable its native Project Gutenberg provider. Pin `SHELFARR_IMAGE` to a tested image digest.
Set PUID/PGID to the service owner's IDs. The web/API port is loopback-only; the
Existing BookOrbit libraries are not mounted into the container. Audible/store beta
companions are not enabled by this compose file.

The read-only `bookorbit_mcp.rb` initializer extends the pinned Shelfarr release:

- Authenticates web users on Shelfarr's login screen directly against BookOrbit's
  credentials API (`POST /api/v1/auth/login`). Synchronizes BookOrbit user ID, username,
  display name, and role (superusers map to Shelfarr admins, non-superusers map to standard readers).
  Local passwords in Shelfarr are updated upon successful login to permit seamless offline
  operation, while local administrator accounts (e.g., recovery) remain accessible via fallback.
- Strictly guards API token administration in `Current#api_admin?`: an account with web UI
  admin privileges retains scoped non-admin access for its MCP tokens unless `requests:admin`
  was explicitly granted to that token.
- `/api/v1/book_research?work_id=...` exposes existing provider descriptions.
- `/api/v1/requests/:id/artifact` streams one completed EPUB/PDF, using native
  bearer scope and request-owner checks. Paths are never caller-supplied or returned.
- `/api/v1/requests/:id/retry_owned` retries an eligible owned request with ordinary
  request-write scope; it never provides cross-user administration.

Artifacts must resolve inside the acquisition output root and be at most 128 MiB.
Container metadata is inspected before native publication: conflicting titles or
authors are held for review. Missing metadata is held unless the original request
explicitly set `allowUnverifiedMetadata:true`. A title/author match is not proof of
edition identity; the job records that distinction. No blind upload follows a hold.
Directories with multiple EPUB/PDF files require manual review. Audiobook delivery
and arbitrary archives are not included in this first version.

Project Gutenberg search uses Shelfarr's native official OPDS catalog and requested
language. Acquisitions use the official source's release URLs.
Source availability and applicable access rights still determine what is obtainable.
Other Shelfarr acquisition providers can be configured separately; no paid source
account, indexer credential or storefront checkout is assumed. Release selection
is explicit initially; queueing alone searches but does not choose a file.

Link each native account to a **different ordinary Shelfarr account**, with only
`search:read requests:read requests:write` token scopes. Do not use the global admin
token or share a reader token between native accounts. The owner-only JSON credential
file has this shape (placeholders only):

```json
{
  "baseUrl":"http://127.0.0.1:5056",
  "accounts":{
    "<native-account-scope-hash>":{"userId":2,"token":"<per-user-token>"}
  }
}
```

The scope is `BookOrbitClient.annotationCacheNamespace()`, derived from authenticated
native `/auth/me` and API origin. It is not a caller-selected username or decoded JWT.
Keep this file mode 0600 outside Git. `PROCUREMENT_DIR` selects the private, persistent
job ledger; use an absolute path and mode-0700 parent. API HTTP is restricted to
loopback; remote APIs require HTTPS. Credentials are never returned by MCP tools.

## Authorization, persistence and recovery

The native account must currently hold `library_upload` and access to the explicit
destination library before queueing, selecting a release and importing. Native
upload enforces its permissions again. Collection membership requires live ownership.
Downloads land in isolated Shelfarr storage; only the native upload publishes them
to BookOrbit. Shared watched Book Dock is not used for private intake.

`procure_book` defaults to `dryRun:true`; repeat the same intent with its
`expectedState` and `dryRun:false`. Stable per-account intent keys prevent repeated
calls from creating repeated local jobs. A persisted `submitting` record precedes
the remote request; an uncertain response reconciles only that user's request list.
Shelfarr request ownership is checked again on subsequent operations.

The job ledger is atomically replaced and written by one serialized writer in the
MCP process. Run one active MCP process for a ledger. It is not a distributed queue
or a database transaction spanning both applications. Back up the credential map,
ledger and Shelfarr storage (including generated encryption keys and SQLite files)
privately using consistent SQLite backup or a coordinated snapshot. Existing source
rollback must not restore older user databases or OAuth credentials.

Every 30 seconds, the MCP server polls jobs belonging to accounts with current
native MCP credentials. `procurement_status` also polls/imports on demand. Failed
permissions/provider calls preserve the job and source artifact for later recovery.
An imported job means the book exists in BookOrbit; it does **not** mean embeddings
have completed. Use `get_index_status` and then ordinary passage search.

Before upload, the ledger records the artifact hash and an uncertain-import state.
If the response is lost, polling never blindly uploads again. After locating the
candidate native book, use `procurement_status` with `action:"reconcile_import"`,
the job ID and book ID. Current access, destination and exact artifact hash must
match; rewritten/different files require review. Cancellation never deletes an
imported book. Staging copies are retained for recovery; automatic staging deletion
is not implemented. Include their disk use in normal operational monitoring.

## Validation

`test/procurement.test.ts` covers preview binding, idempotency, cross-account denial,
revocation, durable import state, uncertain-upload reconciliation and credential
permissions. Existing tests cover catalog pagination and native metadata locks.
Runtime evidence and operational endpoints belong in private checkpoints, not this
public repository. Scoped Shelfarr tokens do not replace BookOrbit authorization.
