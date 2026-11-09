# Embedding providers

Decision: retain LanceDB, SQLite FTS5/BM25, reciprocal-rank fusion, extraction,
source fingerprints, citations and native authorization. Add a small Python
embedding adapter; no new database or provider SDK dependency. Local FastEmbed
remains the default and retains its exact deployed index identity.

## Selected configuration and alternatives

Select **voyage-4-large documents + voyage-4-lite queries, 1024 float dimensions**.
Voyage explicitly documents a shared space across Large/4/Lite and the open-weight
4-nano. This makes Lite queries a supported cost/latency trade-off, not an assumption
based on equal dimensions. Set EMBED_QUERY_MODEL=voyage-4-large if query accuracy
matters more than that trade-off. No corpus-specific quality winner is claimed.
All hosted calls set input_type=document/query, truncation=false and output_dtype=float;
validate count/order/dimensions/finiteness/nonzero vectors and L2-normalize before
storage/query. Cosine distance remains the ranking metric.

Current official published prices per million input tokens (account allowance not
verified): Large $0.12, Lite $0.02, Context4 $0.12. Voyage lists the first200million
tokens free for these models; check your dashboard for actual remaining credit and
limits. At list price,10million document tokens cost $1.20 before allowance.
Overlap, note embeddings, retries after uncertain network outcomes and rebuilds
also consume tokens. Corpus tokens/cost have not been measured. The application
has no billing cap; configure provider-side spending controls. No paid resource or
automatic top-up was purchased/configured.

Voyage supports multilingual retrieval and32K input context. That is a model
capability, not proof of Turkish-to-English quality on this collection.
Context4 embeds grouped chunks with surrounding document context through a
different endpoint (32K supplied groups; up to120K with server auto-chunking).
Defer it: context-aware reuse needs context-group fingerprints, not just exact
chunk text checksums, and automatic chunking must preserve citation provenance.
Do not pass Context4 to this standard adapter or assume its vectors match Large.

Cohere Embed5 Pro/Fast is a credible alternative: shared Pro/Fast space,128K,
100+languages, text/images; published text prices $0.12/$0.08 per million tokens.
Its multimodal strengths require a visual-document path we do not currently have.
Vendor benchmark claims do not establish superiority on our corpus. Supporting a
second hosted API now would add work without a demonstrated need.

Future local inference: existing FastEmbed models remain supported. Voyage4-nano
is published under Apache2.0 with advertised family compatibility, but local
loading/task formatting and API/local parity have NOT been implemented or tested.
BGE, Jina, Qwen, Cohere and Voyage are not interchangeable embedding spaces.

Official sources checked8November2026:
- https://docs.voyageai.com/docs/embeddings
- https://docs.voyageai.com/reference/embeddings-api
- https://docs.voyageai.com/docs/pricing
- https://docs.voyageai.com/docs/contextualized-chunk-embeddings
- https://blog.voyageai.com/2026/01/15/voyage-4/
- https://docs.cohere.com/docs/cohere-embed
- https://cohere.com/blog/embed-5

## Configuration and content transfer

Set environment variables (see .env.example):

```
EMBED_PROVIDER=voyage
EMBED_MODEL=voyage-4-large
EMBED_QUERY_MODEL=voyage-4-lite
EMBED_DIMENSIONS=1024
EMBED_REVISION=1
EMBED_ALLOW_EXTERNAL_CONTENT=1
VOYAGE_API_KEY=<set privately, never commit>
```

**External content transfer:** enabling Voyage sends book passages, search queries,
and text/comments used by semantic own-annotation search to api.voyageai.com via
validated HTTPS. This applies to accessible private books too. Lexical-only search,
PDF reading and citation resolution do not call the embedding API. The consent
flag and a key are required before the first remote embedding. No API key appears
in status/logs; no provider error body is propagated. Review provider data-handling
terms for your needs; no contractual retention guarantee is asserted here.

The endpoint is fixed HTTPS with normal certificate verification; redirects are
rejected. Bounded retries apply to429/selected5xx/network failures, never401/403.
Requests time out after45seconds, with up to4attempts. A429 without Retry-After
waits30seconds before retry, allowing a minute-long low-tier window to reset. Model errors cannot silently
fall back to BGE and corrupt the vector space. Invalid vectors fail before staging.
Up to128passages per indexing batch (automatically split at the byte cap); conservative UTF-8 byte caps split oversized batches
and reject individual inputs above30000bytes instead of silently truncating them.
Provider limits may still delay work; this is synchronous batching, not Voyage's
asynchronous discounted Batch API. Completed batches resume from SQLite staging.

Annotations remain live own-user snapshots with a persistent, account/model-scoped
vector cache in `KNOWLEDGE_DIR/<indexIdentity>/annotations.sqlite3` (mode600).
Hosted semantic search sends uncached note text and queries to Voyage. The existing
500-note scan and4000-character embedding limit remain. Reconnects/restarts reuse
unchanged document vectors; queries are still embedded. No annotation text, passwords
or tokens are stored in this cache. It is derived data and can be removed while MCP
is stopped without modifying BookOrbit notes (remove SQLite WAL/SHM together).

The cache uses SHA256 of server API origin + the ID returned by authenticated
`GET /auth/me`, never a supplied user ID or decoded JWT. Annotation version and
embedding-text SHA256 invalidate edited vectors; model-specific directories prevent
incompatible reuse. Complete unfiltered snapshots purge absent/inaccessible rows;
partial/filtered searches cannot purge unseen notes. Remaining unused rows expire
on subsequent searches after30days, with caps4096/account and16384/model. These
limits bound retention, not search coverage. Cache entries never authorize results:
fresh own-note snapshots and post-ranking access/version checks remain mandatory.
Private model caches are covered by normal derived-data backup/permissions policy;
no new backup schedule was introduced.

## Index identity, incremental indexing and recovery

Provider/document model/revision/dimension/dtype/normalization/input convention and
chunker identity select a separate derived directory. The supported compatible
query-model change does not change that identity. Revisions are operator-controlled
rebuild versions, not a claim of provider-pinned immutable model weights.

Same-index unchanged source: skip indexing. Interrupted source: resume staged
batches. Source metadata refresh: reuse exact same-book text SHA vectors only within
that index. Changing document model/dimension/revision/provider builds a new index;
old BGE data remain intact. Do not copy vectors between directories. Targeted queue,
priority, pause/retry tools continue to operate on the selected index.

Permission-filtered current catalog/fingerprints constrain vector AND lexical
candidates before ranking; native authorization is checked again before passage
return. Cross-book retrieval does not bypass permissions. No shared service
credential or auth/schema change. BookOrbit administrators retain native visibility.
Books and native metadata remain authoritative and are never rewritten by indexing.

The BGE0.65 similarity threshold is NOT portable. Voyage defaults to0: returned
semantic hits are explicitly candidates, not proof, and may be irrelevant.
MIN_SEMANTIC_SIMILARITY is configurable; calibrate from a few real queries rather
than presenting cosine similarity as confidence. No silent keyword-only fallback
on provider failure; request fails explicitly, while lexical-only remains usable.

## Validation and deployment

Offline checks:

```sh
npm run build
npm run lint
npm test
.venv/bin/python -m unittest discover -s knowledge -p 'test_*.py' -v
```

Production configuration belongs in an owner-readable environment file outside
Git. Set PUBLIC_URL to your externally reachable HTTPS origin and BOOKORBIT_URL
to your native BookOrbit API origin. Never commit real hostnames, account names,
credentials, deployment inventories or raw operational logs. Use
`deployment/environment.example` as a template; supply values privately.

Changing provider/model/dimensions/revision selects a separate derived index.
Keep previous indexes until the replacement is verified. Roll back application
code/configuration independently of native books, metadata and OAuth state.
Do not restore old authoritative databases merely to roll back an embedding change.

One indexing worker serializes jobs, commits up to128Voyage vectors per durable
batch and splits requests conservatively by bytes. PDF_MAX_MIB defaults to80 and
accepts integers1..128; page/character limits still apply. Configure provider limits
for your own account; no specific quota or throughput is assumed.
