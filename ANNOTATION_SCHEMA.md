# Atomic highlights and notes: LanceDB schema v1

Status: **atomic ingestion/search and focused lifecycle tests implemented**.
Set `ANNOTATION_INDEX=lancedb` to enable; `legacy` remains the default and rollback
path. The old SQLite cache is preserved. No book-index rebuild is required.

## Decision

Use the existing LanceDB infrastructure with separate `annotation_units_v1` and
`annotation_passage_links_v1` tables under a model-specific private directory.
Executable contracts: `knowledge/annotation_schema.py`; explicit PyArrow schemas,
fixed-size float32 vectors, version/model metadata, fail-closed filter builder and
non-destructive table initializer. The worker initializes the annotation tables
lazily in a separate private `annotations.lancedb` directory within the model index.
Current Voyage vectors have1024dimensions; factories require the actual dimensions
and compatible model identity rather than hardcode one provider. No new dependency.

A native highlight and its attached comment are distinct semantic units. Preserve
both as authored, without200-word chunking, splitting into sentences, or combining
them into one vector. A highlight-only annotation yields one `highlight` row;
a highlight with commentary yields a `highlight` and a `note` row; a note without
selected text yields only a `note` row. Empty components produce no vector row.
Association through native annotation ID preserves the note's relationship to the
highlight. Other note sources without a BookOrbit annotation ID are out of scope.

Atomic means one logical selected passage or authored comment, not necessarily one
sentence. Over-provider-limit units must be explicitly reported as unindexed;
never silently truncate or silently split. They need a later deliberate policy.
The atomic path replaces the old4000-character embedding cap. Local FastEmbed
inputs are checked against the full tokenizer limit without truncation as well.

## Table: annotation_units_v1

| Fields | Type / meaning |
|---|---|
| `id` | SHA256(owner_scope, native annotation ID, kind); stable across content edits |
| `owner_scope` | Existing64hex scope from server API identity + authenticated `/auth/me` ID; never supplied by MCP caller |
| `annotation_id`, `kind` | Native int64 ID; kind `highlight` or `note` |
| `book_id`, `library_id` | Native int64 IDs; library is descriptive metadata, not a cached access grant |
| `annotation_version` | SHA256 of current source annotation fields, including text/comment and reader location |
| `source_version` | Current BookOrbit book/file fingerprint, same contract as passage retrieval |
| `text` | Full exact selected text or personal comment; sensitive derived copy |
| `text_sha256` | SHA256 of full component text |
| `embedding_text_sha256` | SHA256 of actual embedding input; separately detects preprocessing changes |
| `embedding_input_mode` | `document` under the current Voyage contract |
| `embedding_provenance` | `direct` or `exact_passage_reuse`; no approximate passage vector presented as exact highlight embedding |
| `vector` | Non-null fixed-size float32 list of the declared model dimension |
| `indexed_at` | UTC timestamp, milliseconds |
| `reader_page`, `reader_cfi`, `reader_chapter`, `reader_chapter_index`, `reader_file_id`, `reader_origin`, `reader_position_status` | Nullable native location fields; no invented printed page, section/CFI conversion or exact-page browser link |
| `source_created_at` | Nullable raw native creation timestamp; do not invent an upstream modification timestamp |
| `reused_passage_id` | Nullable; only populated for verified exact-input vector reuse |

Schema metadata records schema version1, model/index identity, dimensions and atomic
input policy. Provider/model revision/dimensions/normalization/modes must match the
embedding contract. Same dimensions alone do not establish compatibility. Existing
book `EmbeddingConfig.identity` can identify the current compatible vector space;
annotation table version/atomic policy remains separate from book chunk identity.
An incompatible schema/model is rejected, not overwritten. Nullable location fields
are intentional; no placeholder page0 or fabricated anchor.

LanceDB does not enforce enum domains, key uniqueness or these authorization
invariants automatically. The ingestion path must validate fields and upsert by
`id`; raw append can duplicate rows. The schema factory itself is not a complete
input-validation or synchronization service.

## Table: annotation_passage_links_v1

One annotation unit can map to multiple passages; many users can highlight the
same shared passage. Keep these relationships separate from the shared passage
rows and their vectors.

Required: `id`, `owner_scope`, `unit_id`, `annotation_version`, `book_id`,
`source_version`, `passage_id`, `passage_index_identity`, `match_method`, `section`.
Nullable: `char_start`, `char_end`, measured in the matching extracted source section,
with an exclusive end. Full location remains on the unit. Link `id` should be a
stable hash of scoped unit ID, annotation/source versions and passage identity.

Initial verified methods: `exact_text` or `verified_location`. Offsets must be
validated against actual extracted text; native reader positions are not assumed
to use our character coordinate system. Unknown or ambiguous matches produce no
verified link. A text search suggestion is not a verified mapping. `section` is
our extracted section index, distinct from native reader_chapter_index.

Links support retrieving context from existing book vectors without generating
another embedding. That is contextual passage retrieval, not an embedding of the
exact selection. `exact_passage_reuse` requires equal input bytes/checksum, model
identity, preprocessing and input mode; arbitrary substring highlights do not
qualify. No vector subtraction or averaging is treated as exact reuse.

## Authorization and consistency contract

1. Resolve account scope through native authenticated `/auth/me`.
2. Get current permitted book IDs/source versions and active own annotation versions.
3. Require owner scope AND current book/source AND current unit/version in the
   LanceDB query **before vector top-k**. `authorized_filter` validates IDs/hashes
   and returns `false` for empty candidates. Use `prefilter=True` explicitly.
4. Recheck live own-note versions and book access before returning text/context.
   Permission metadata alone never authorizes a result, including after moves.
5. Resolve links only under the same owner/unit/annotation/source versions and
   current authorized passage version. No unrestricted table or SQL MCP tool.

Embedded LanceDB provides filtering, not an automatically enforced per-row user ACL.
All reads, writes, deletes and future FTS paths must obey this server boundary.
No ANN/scalar index is needed for the initial small account datasets. Queries use
exact owner/current-book/current-unit prefilters in partitions of64live IDs, then
merge their top candidates globally. Unauthorized global neighbors cannot crowd
out authorized results. Lexical-only calls read live native components without
embedding requests or private-text index writes.

For synchronization: publish a successfully embedded new unit version by stable-ID
upsert; edits invalidate prior versions, location-only changes can reuse identical
embedding inputs. Deletion/removal/revocation must exclude rows immediately at the
query boundary, regardless of cleanup progress. Never delete another account's
rows. A failed/partial snapshot cannot prove unseen annotations were deleted.
Links are rebuildable; there is no cross-table transaction promise. Version matching
must fail closed across partial unit/link publication. Never modify original notes.
Historical Lance versions may retain deleted text until version cleanup; retention
and backup handling must be specified before importing real annotation text.

## Migration constraints and next action

The live SQLite cache stores one embedding of combined/truncated highlight+comment,
not the two atomic units defined here, and does not retain text. Do not blindly copy
those vectors into new highlight/note rows. Refetch authoritative notes and compare
exact embedding input hashes. Only byte-identical, untruncated compatible units can
reuse a cached vector; changed/split input needs a new embedding. Preserve the old
cache and runtime for rollback; no index-wide book re-embedding is needed.

## Runtime behavior and recovery

Search exhausts native annotation pages instead of stopping at500notes. A repeated
page fails explicitly; changing totals report an incomplete snapshot and cannot
trigger deletion cleanup. Safety bounds are50000records/64MiB per live snapshot;
narrow book scope if exceeded. These are operational bounds, not an unreported
recent-note shortcut. Final candidate notes are refetched across all native pages
for that book, and current book/source access is checked again before response.

Upserts publish completed embedding batches. Interrupted sync restarts from a fresh
native snapshot and reuses already persisted exact inputs; it does not trust a
stale pagination cursor as authorization. Location-only edits reuse their vector.
Changed text embeds again. Only exact bytes from a compatible legacy input or an
exact current source passage can reuse that vector. A highlight substring gets
its own embedding; verified unique exact-text matches may link it to source context.
Ambiguous/truncated source lookup yields no certified link.

With AUTO_INDEX enabled, currently authenticated accounts synchronize annotations
at most once every five minutes in the existing background worker. Searches also
synchronize on demand. `get_index_status.annotations` reports account-scoped stored
unit counts and sync state; stored rows are not an access grant or live coverage
proof. Search responses report actual scan coverage, atomic unit counts and errors.
Results preserve the native annotation envelope and add `matchedUnits` plus verified
`sourceLinks`; response fields remain bounded with explicit truncation flags.

**Private text retention:** LanceDB contains full highlight/comment text. Keep its
parent owner-only and any backup encrypted/private. Complete unfiltered snapshots
remove obsolete owner rows; partial/filtered snapshots cannot remove unseen notes.
Inactive-account rows expire after30days when maintenance next runs. Daily sync
maintenance compacts and cleans historical versions using a24-hour cutoff, with
unverified-file deletion disabled. This is not secure physical erasure or a strict
wall-clock deletion guarantee while offline; backups may retain older copies.
Permissions and current note versions exclude stale text immediately on queries,
independent of disk cleanup. Never restore a historical table to serve stale notes.

Rollback: set ANNOTATION_INDEX=legacy and restart MCP only. Do not delete or restore
BookOrbit notes, books, OAuth state or the old SQLite cache. The derived annotation
LanceDB can be rebuilt from native records; no passage reindex is required.

## Verification

`.venv/bin/python -m unittest discover -s knowledge -p test_annotation_schema.py`
exercises4schema tests using real local LanceDB0.41.0 and synthetic data only.
`test_annotation_index.py` adds6real Lance lifecycle tests, including610units,
interrupted-batch resume, exact reuse, edits, owner isolation and complete/partial
cleanup. Node atomic tests cover774notes, full separate components, live final
checks, lexical-only behavior and pagination failures.
Tests cover stable scoped component IDs, fixed-size vector schema/model mismatch
rejection, owner/book/current-version prefiltering before top-k, fail-closed empty
candidate sets and distinct ownership links to a shared passage.

API references: [explicit schemas and upserts](https://docs.lancedb.com/ingestion),
[prefiltering](https://docs.lancedb.com/search/filtering). Pinned installed API was
exercised; no database/model comparison campaign or external embedding calls.
