# PDF reading and library maintenance

The existing native authorization and retrieval tools remain available. Two
additional read-only tools provide bounded visual reading and exception reporting.
The server exposes51tools when BOOKORBIT_EXTENSIONS=1 (33upstream +18extensions).
See [AI-assisted organization](ORGANIZATION.md) for collection and smart-scope writes.

## Read equations, diagrams and difficult layouts

`view_pdf_pages({"bookId":123,"startPage":24,"pageCount":1})` returns a text
citation followed by a JPEG image for each requested page. Pages are1-based physical
PDF pages, not printed pagination. At most2pages,1600pixels on the longest side and
2MiB per image. File download/encryption/page limits remain enforced. Current
native book access and source version are checked again after rendering, before
returning any images. No path, token or unauthenticated download link is exposed.

Rendering runs locally. No new external vision provider or image-vector index is
introduced. Images are sent to the authenticated MCP client; the client must support
image tool results and provide its own visual reasoning. Mathematical correctness,
OCR quality and diagram interpretation are not guaranteed by rendering an image.
Use the images alongside text/citations, especially for flattened equations/tables.

`read_pdf_pages` also accepts `layoutAware:true`. This uses a bounded page window,
tries two-column ordering where both columns have sufficient text, and suppresses
short repeated margin blocks across the requested pages. Returned `layout` describes
what was detected. This is a conservative heuristic, not full document-layout or
mathematical understanding. A one-page request cannot prove a header repeats.
Selective local OCR remains limited to sparse native-text pages.

Existing passage indexes/citations are not rewritten. Layout-aware reading does
not silently reembed the library or reinterpret stored character offsets. EPUB
image OCR, image embeddings, table structure and formula recognition remain outside
this implementation. Use `get_passage` for exact indexed text/context.

## Maintenance without routine UI inspection

`maintenance_report({})` refreshes current native access and summarizes:

- Supported-book indexing coverage, pending IDs and failed/paused jobs.
- Own annotation index state/counts.
- Missing catalog metadata and possible title/author duplicates.
- Library watch/import automation and permitted metadata queue counts.

Native filename title fallbacks can hide missing raw title metadata; the report
states this limitation. Duplicate candidates require review. It does not delete,
merge, rename or overwrite books. Native metadata-management permissions still
apply; ordinary accounts receive null for unavailable management-only state.
Global current-item names and provider error bodies are never returned.

Set `MAINTENANCE_REPORTS=1` to save an hourly account-scoped report under the private
cache `maintenance/<authenticated-account-scope>.json`. Only currently authenticated
accounts are processed, using their own native client. Files are mode600, parent
mode700, atomically replaced; inactive reports expire after30days on subsequent
report maintenance. They contain private catalog IDs/status and belong outside Git.
The MCP tool always computes a fresh report; cached files never authorize responses.
No notification/email integration is enabled.

For action, use existing `audit_library`, `library_maintenance`, `update_book_metadata`
and `control_indexing`. Native watchers and metadata-on-import remain responsible
for ordinary ingestion. Existing preview/state matching, metadata locks and
preservation of nonempty fields remain in effect. No new autonomous bulk-rename,
duplicate deletion or provider-selection policy is assumed.
