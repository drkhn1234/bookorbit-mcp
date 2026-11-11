import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { BookOrbitClient } from "./bookorbit-client.js";
import { knowledgeWorker } from "./knowledge-worker.js";

type Account = { token: string; userId: number };
type Config = { baseUrl: string; accounts: Record<string, Account> };
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
  source?: string;
  sourceName?: string;
  indexer?: string;
  protocol?: string;
  format?: string;
  releaseTitle?: string;
};
const digest = (v: unknown) =>
  createHash("sha256")
    .update(Buffer.isBuffer(v) ? v : JSON.stringify(v))
    .digest("hex");
const workIdSchema = z
  .string()
  .regex(/^(openlibrary|hardcover|google_books):[A-Za-z0-9_-]{1,100}$/);

// Native upload may derive the display title from the filename. Use the
// inspected book title and keep it a bounded leaf, never a path or job UUID.
function uploadFilename(title: string, format: "epub" | "pdf"): string {
  const clean = title
    .normalize("NFC")
    .replace(/[\\/:*?"<>|\p{Cc}]/gu, " ")
    .replace(/^[.\s]+|[.\s]+$/g, "");
  let leaf = "";
  for (const char of clean) {
    if (Buffer.byteLength(leaf + char) > 180) break;
    leaf += char;
  }
  return `${leaf.trim() || "Acquired book"}.${format}`;
}
// One serialized ledger/import writer per MCP process. Native data remains authoritative.
let serial: Promise<unknown> = Promise.resolve();
async function readBounded(response: Response, limit: number): Promise<Buffer> {
  if (Number(response.headers.get("content-length")) > limit) {
    await response.body?.cancel();
    throw new Error("Acquisition response exceeds size limit");
  }
  const reader = response.body!.getReader(),
    chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > limit) throw new Error("Acquisition response exceeds size limit");
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  return Buffer.concat(chunks);
}
async function exclusive<T>(fn: () => Promise<T>): Promise<T> {
  const next = serial.catch(() => {}).then(fn);
  serial = next;
  return next;
}

export class ProcurementService {
  constructor(
    private readonly native: BookOrbitClient,
    private readonly configPath = process.env.SHELFARR_CONFIG_FILE,
    private readonly directory = process.env.PROCUREMENT_DIR ??
      join(process.env.CACHE_DIR ?? ".cache", "procurement"),
    private readonly fetcher: typeof fetch = fetch,
    private readonly inspect: (data: unknown) => Promise<any> = (data) =>
      knowledgeWorker.request(data),
  ) {}

  private async context() {
    if (!this.configPath) throw new Error("Shelfarr acquisition is not configured");
    const info = await stat(this.configPath);
    if (info.mode & 0o077) throw new Error("Shelfarr credential file must be owner-only");
    const config = JSON.parse(await readFile(this.configPath, "utf8")) as Config;
    const origin = new URL(config.baseUrl);
    if (
      origin.username ||
      origin.password ||
      !["http:", "https:"].includes(origin.protocol)
    )
      throw new Error("Invalid acquisition origin");
    if (
      origin.protocol === "http:" &&
      !["127.0.0.1", "localhost", "[::1]"].includes(origin.hostname)
    )
      throw new Error("Acquisition HTTP requires loopback; use HTTPS elsewhere");
    const scope = await this.native.annotationCacheNamespace();
    const account = config.accounts[scope];
    if (!account?.token || !Number.isSafeInteger(account.userId))
      throw new Error("This BookOrbit account has no linked Shelfarr account");
    return { scope, account, base: origin.origin };
  }

  private async request(path: string, method = "GET", body?: unknown) {
    const ctx = await this.context();
    const response = await this.fetcher(ctx.base + path, {
      method,
      headers: {
        Authorization: `Bearer ${ctx.account.token}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      redirect: "error",
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(
        `Shelfarr request failed (HTTP ${response.status}); credentials and provider responses suppressed`,
      );
    }
    return response;
  }

  private async json(path: string, method = "GET", body?: unknown): Promise<any> {
    const response = await this.request(path, method, body);
    return JSON.parse((await readBounded(response, 2_000_000)).toString("utf8"));
  }

  private async load(): Promise<Job[]> {
    const { scope } = await this.context();
    try {
      return JSON.parse(await readFile(join(this.directory, scope + ".json"), "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  private async save(jobs: Job[]) {
    const { scope } = await this.context();
    if (jobs.length > 1000)
      throw new Error(
        "Acquisition ledger full; archive completed jobs before requesting more",
      );
    const target = join(this.directory, scope + ".json"),
      tmp = target + "." + randomUUID();
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await writeFile(tmp, JSON.stringify(jobs), { mode: 0o600 });
    await rename(tmp, target);
  }

  async sources() {
    const raw = await this.json("/api/v1/sources");
    return {
      acquisitionSources: raw.acquisition_sources,
      metadataSources: raw.metadata_sources,
      storeProviders: raw.store_providers,
      downloadPreferences: raw.download_preferences,
      discernmentNote:
        "Acquisition sources indicate where book releases/files can be obtained (e.g. Project Gutenberg for public domain ebooks, shadow libraries, or torrent/usenet indexers). Metadata sources provide bibliographic information and ratings.",
    };
  }

  async discover(query: string, limit: number) {
    const [external, owned] = await Promise.all([
      this.json(
        `/api/v1/search?${new URLSearchParams({ q: query, limit: String(limit) })}`,
      ),
      this.native.searchBooks(query, limit),
    ]);
    const candidates = external.results ?? [];
    const distinctSources = Array.from(
      new Set(
        candidates
          .map((c: any) => c.source_name || c.source)
          .filter(Boolean),
      ),
    );
    return {
      candidates,
      sourcesSummary: distinctSources,
      accessibleCatalogMatches: owned.map((b) => ({
        bookId: b.id,
        title: b.title,
        authors: b.authors,
      })),
      ownershipNote:
        "Catalog matches are scoped to your current account; a missing match is not proof a work is absent. Resolve editions before acquisition.",
    };
  }

  async research(workId: string, title: string, author?: string) {
    const [details, enrichment] = await Promise.allSettled([
      this.json(`/api/v1/book_research?${new URLSearchParams({ work_id: workId })}`),
      this.native.searchBookMetadata(title, author),
    ]);
    const candidates: Record<string, unknown>[] = [];
    let visited = 0;
    const visit = (v: any) => {
      if (++visited > 500 || candidates.length >= 15 || !v || typeof v !== "object")
        return;
      if (v.title && (v.provider || v.sourceUrl)) {
        const item = Object.fromEntries(
          [
            "provider",
            "title",
            "authors",
            "publisher",
            "publishedYear",
            "isbn13",
            "sourceUrl",
            "description",
            "communityRating",
            "communityRatingCount",
          ]
            .filter((k) => v[k] !== undefined)
            .map((k) => [
              k,
              typeof v[k] === "string"
                ? v[k].slice(0, k === "description" ? 5000 : 1000)
                : v[k],
            ]),
        );
        candidates.push(item);
      } else for (const value of Object.values(v)) visit(value);
    };
    if (enrichment.status === "fulfilled") visit(enrichment.value);
    const detailsVal = details.status === "fulfilled" ? details.value : null;
    return {
      workId,
      retrievedAt: new Date().toISOString(),
      details: detailsVal,
      sourceProvenance: detailsVal
        ? {
            source: detailsVal.source ?? null,
            sourceName: detailsVal.source_name ?? null,
            sourceUrl: detailsVal.source_url ?? null,
            sourceAttribution: detailsVal.source_attribution ?? null,
          }
        : null,
      metadataCandidates: candidates,
      providerStatus: { shelfarr: details.status, bookorbit: enrichment.status },
      limitations:
        "Aggregate ratings are provider-specific BookOrbit values, not personal ratings or a unified quality score. Individual review text is not fetched; use source links for client web research. Confirm author/ISBN/edition before relying on a candidate.",
    };
  }

  async create(input: {
    workId: string;
    title: string;
    author: string;
    language: string;
    libraryId: number;
    collectionId?: number;
    allowUnverifiedMetadata?: boolean;
    dryRun: boolean;
    expectedState?: string;
  }) {
    return exclusive(async () => {
      const { dryRun, expectedState, ...intent } = input;
      const { scope } = await this.context();
      await this.native.assertLibraryUpload(input.libraryId);
      const collection = input.collectionId
        ? ((await this.native.getCollection(input.collectionId)) as any)
        : null;
      if (collection && collection.isOwner !== true)
        throw new Error("Destination collection must be owned by the current account");
      const expected = digest({
        scope,
        intent,
        collection: collection && {
          id: collection.id,
          name: collection.name,
          isOwner: collection.isOwner,
        },
      });
      const jobs = await this.load(),
        key = digest(intent);
      const existing = jobs.find((j) => j.key === key && j.state !== "cancelled");
      if (existing) return { existing: true, job: existing };
      if (dryRun)
        return {
          dryRun: true,
          expectedState: expected,
          destinationLibraryId: input.libraryId,
          collectionId: input.collectionId,
          workId: input.workId,
          title: input.title,
          language: input.language,
          note: "Queues an ebook request; approved source selection may begin acquisition. No paid checkout. EPUB/PDF imports recheck current native permissions.",
        };
      if (expected !== expectedState)
        throw new Error("Request changed or preview missing; run dryRun again");
      const job: Job = {
        ...intent,
        id: randomUUID(),
        key,
        state: "submitting",
        createdAt: new Date().toISOString(),
      };
      jobs.push(job);
      await this.save(jobs); // Persist intent before any external side effect.
      try {
        const response = await this.json("/api/v1/requests", "POST", {
          work_id: input.workId,
          title: input.title,
          author: input.author,
          book_type: "ebook",
          language: input.language,
          external_source: "bookorbit_mcp",
          external_chat_id: job.id,
        });
        const requests = response.requests ?? [];
        const account = (await this.context()).account;
        const found = requests.find(
          (r: any) => r.book?.work_id === input.workId && r.user?.id === account.userId,
        );
        if (!found)
          throw new Error("No owned request returned; reconcile status before retrying");
        job.requestId = found.id;
        job.state = found.status;
      } catch {
        job.state = "submission_uncertain";
        job.error =
          "Submission not confirmed. Status reconciles your own request list; do not blindly submit again.";
      }
      await this.save(jobs);
      return { job };
    });
  }

  private async remote(job: Job) {
    const { account } = await this.context();
    const r = await this.json(`/api/v1/requests/${job.requestId}`);
    if (r.user?.id !== account.userId) throw new Error("Acquisition owner mismatch");
    return r;
  }

  async releases(jobId: string, selectedResultId?: number) {
    return exclusive(async () => {
      const jobs = await this.load(),
        job = jobs.find((j) => j.id === jobId);
      if (!job?.requestId) throw new Error("Owned acquisition not found");
      await this.native.assertLibraryUpload(job.libraryId);
      await this.remote(job);
      if (selectedResultId)
        await this.json(`/api/v1/requests/${job.requestId}/grab`, "POST", {
          search_result_id: selectedResultId,
        });
      const response = await this.json(
        `/api/v1/requests/${job.requestId}/search_results`,
      );
      const rawReleases = response.search_results ?? [];
      const releases = rawReleases.map((r: any) => ({
        id: r.id,
        title: r.title,
        source: r.source,
        sourceName:
          r.source_name ||
          (r.source === "gutenberg"
            ? "Project Gutenberg"
            : r.source === "anna_archive"
              ? "Anna's Archive"
              : r.source === "zlibrary"
                ? "Z-Library"
                : r.indexer || r.source),
        indexer: r.indexer || null,
        protocol:
          r.protocol ||
          r.download_type ||
          (["gutenberg", "anna_archive", "zlibrary", "librivox"].includes(r.source)
            ? "direct"
            : "torrent"),
        format: r.format || r.primary_extension || null,
        detectedExtensions: r.detected_extensions || [],
        sizeBytes: r.size_bytes ?? null,
        sizeHuman:
          r.size_human ??
          (r.size_bytes
            ? `${Math.round((r.size_bytes / (1024 * 1024)) * 10) / 10} MB`
            : null),
        confidenceScore: r.confidence_score ?? null,
        confidenceLevel:
          r.confidence_level ??
          (r.confidence_score >= 90
            ? "high"
            : r.confidence_score >= 70
              ? "medium"
              : "low"),
        detectedLanguage: r.detected_language ?? null,
        languageName: r.language_name ?? null,
        infoUrl: r.info_url || null,
        status: r.status,
        downloadable: r.downloadable,
        blocklisted: r.blocklisted,
        blocklistReason: r.blocklist_reason || null,
      }));
      if (selectedResultId) {
        const selected = releases.find((r: any) => r.id === selectedResultId);
        if (selected) {
          job.source = selected.source;
          job.sourceName = selected.sourceName;
          job.indexer = selected.indexer;
          job.protocol = selected.protocol;
          job.format = selected.format;
          job.releaseTitle = selected.title;
          await this.save(jobs);
        }
      }
      const sourcesSummary = Array.from(
        new Set(
          releases.map(
            (r: any) => `${r.sourceName}${r.protocol ? ` (${r.protocol})` : ""}`,
          ),
        ),
      );
      // Native API omits credentialed artifact URLs; never surface filesystem paths.
      return {
        jobId,
        releases,
        sourcesSummary,
        storeOffers: response.store_offers,
        checkout: "External seller only; no purchase performed",
      };
    });
  }

  async status(jobId?: string, action = "status", reconcileBookId?: number) {
    return exclusive(async () => {
      if (action !== "status" && !jobId)
        throw new Error("An explicit owned jobId is required for this action");
      const jobs = await this.load();
      if (jobId && !jobs.some((j) => j.id === jobId))
        throw new Error("Owned acquisition not found");
      for (const job of jobs.filter((j) => !jobId || j.id === jobId)) {
        if (
          ["cancelled", "ready", "needs_review"].includes(job.state) &&
          action === "status"
        )
          continue;
        if (action === "reconcile_import") {
          if (!reconcileBookId || !job.sha256 || job.state !== "import_uncertain")
            throw new Error(
              "Reconciliation requires an uncertain job and an explicit native bookId",
            );
          await this.native.assertLibraryUpload(job.libraryId);
          const book = await this.native.getBook(reconcileBookId);
          if (book.libraryId !== job.libraryId)
            throw new Error("Reconciliation destination mismatch");
          let matched = false;
          for (const file of book.files.filter((f) =>
            ["epub", "pdf"].includes(f.format),
          )) {
            if (
              digest(await this.native.downloadFile(file.id, 128 * 1024 * 1024)) ===
              job.sha256
            )
              matched = true;
          }
          if (!matched)
            throw new Error(
              "Existing book does not match the verified artifact hash; manual review required",
            );
          job.bookId = book.id;
          job.state = "imported";
          delete job.error;
          await this.save(jobs);
        }
        if (job.state === "imported" && (!job.collectionId || job.collectionAdded))
          continue;
        try {
          if (!job.requestId) {
            const { account } = await this.context();
            const list = await this.json("/api/v1/requests?limit=100&created_via=api");
            const matches = (list.requests ?? []).filter(
              (r: any) => r.user?.id === account.userId && r.book?.work_id === job.workId,
            );
            if (matches.length !== 1) continue;
            job.requestId = matches[0].id;
          }
          const remote = await this.remote(job);
          if (remote.selected_release) {
            job.source = remote.selected_release.source;
            job.sourceName = remote.selected_release.source_name;
            job.indexer = remote.selected_release.indexer;
            job.protocol = remote.selected_release.protocol;
            job.format = remote.selected_release.format;
            job.releaseTitle = remote.selected_release.title;
          }
          if (action === "retry_search") {
            if (job.bookId)
              throw new Error(
                "Already imported; source retry cannot replace a native book",
              );
            await this.native.assertLibraryUpload(job.libraryId);
            await this.json(`/api/v1/requests/${job.requestId}/retry_owned`, "POST", {});
            job.state = "searching";
            delete job.error;
            continue;
          }
          if (action === "cancel") {
            if (job.bookId)
              throw new Error(
                "Already imported; cancellation never deletes library books",
              );
            if (remote.status !== "completed")
              await this.json(`/api/v1/requests/${job.requestId}`, "DELETE");
            job.state = "cancelled";
            continue;
          }
          if (job.state === "import_uncertain") continue;
          if (remote.status !== "completed") {
            job.state = remote.status;
            continue;
          }
          await this.native.assertLibraryUpload(job.libraryId);
          if (!job.bookId) {
            const response = await this.request(
              `/api/v1/requests/${job.requestId}/artifact`,
            );
            const bytes = await readBounded(response, 128 * 1024 * 1024),
              pdf = bytes.subarray(0, 5).toString() === "%PDF-",
              epub = bytes[0] === 80 && bytes[1] === 75;
            let verification;
            try {
              if (!pdf && !epub) throw new Error("Not EPUB/PDF");
              verification = await this.inspect({
                op: "inspect_acquisition",
                data: bytes.toString("base64"),
                title: job.title,
                author: job.author,
              });
            } catch {
              job.state = "needs_review";
              job.error =
                "Artifact could not be validated as a readable EPUB/PDF; no native book was published";
              continue;
            }
            job.verification = {
              metadataMatch: verification.metadataMatch,
              editionVerified: false,
            };
            if (
              verification.metadataMatch === "mismatch" ||
              (verification.metadataMatch !== "verified" && !job.allowUnverifiedMetadata)
            ) {
              job.state = "needs_review";
              job.error =
                "Artifact metadata conflicts with the request or cannot verify it; no native book was published";
              continue;
            }
            job.sha256 = digest(bytes);
            job.state = "import_uncertain";
            await this.save(jobs);
            const uploaded = await this.native.uploadBook(
              job.libraryId,
              bytes,
              uploadFilename(verification.title || job.title, pdf ? "pdf" : "epub"),
            );
            if (!Number.isSafeInteger(uploaded.bookId))
              throw new Error("Import response has no book identity");
            job.bookId = uploaded.bookId;
            job.state = "imported";
            await this.save(jobs);
          }
          const book = await this.native.getBook(job.bookId!);
          if (book.libraryId !== job.libraryId)
            throw new Error("Imported book destination changed");
          if (job.collectionId && !job.collectionAdded) {
            const collection = (await this.native.getCollection(job.collectionId)) as any;
            if (collection.isOwner !== true)
              throw new Error("Destination collection no longer owned");
            await this.native.changeCollectionBooks(job.collectionId, "add_books", [
              job.bookId!,
            ]);
            job.collectionAdded = true;
          }
          // Indexing belongs to the existing worker; do not falsely claim ready.
          job.state = "imported";
          delete job.error;
        } catch {
          job.error =
            "Acquisition/import paused: check current permissions, source status or uncertain import before retrying";
        }
      }
      await this.save(jobs);
      return {
        jobs: jobs.filter((j) => !jobId || j.id === jobId),
        indexing:
          "Imported books are queued by normal background indexing; use get_index_status before claiming passage retrieval is ready",
      };
    });
  }
}

export function registerProcurementTools(server: McpServer, native: BookOrbitClient) {
  const service = new ProcurementService(native);
  const result = (value: unknown) => ({
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
  });
  const guard = async (fn: () => Promise<unknown>) => {
    try {
      return result(await fn());
    } catch (e) {
      return { ...result({ error: (e as Error).message }), isError: true };
    }
  };
  server.registerTool(
    "get_procurement_sources",
    {
      description:
        "Inspect configured and available acquisition sources (e.g. Project Gutenberg, Anna's Archive, Z-Library, torrent/usenet indexers), metadata providers (Open Library, Google Books, Hardcover), and commercial store offers. Discerns source types (direct HTTP, torrent, usenet), supported media (ebook, audiobook), and current provider health/status.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => guard(() => service.sources()),
  );
  server.registerTool(
    "discover_books",
    {
      description:
        "Discover external books through Shelfarr and check only your accessible BookOrbit catalog. Candidate results identify metadata source provenance (e.g. Open Library, Google Books, Hardcover). Translate conceptual questions into candidate searches; not a full-text search of external books.",
      inputSchema: {
        query: z.string().trim().min(1).max(500),
        limit: z.number().int().min(1).max(20).default(10),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ query, limit }) => guard(() => service.discover(query, limit)),
  );
  server.registerTool(
    "research_book",
    {
      description:
        "Research a selected external work using Shelfarr descriptions and configured BookOrbit metadata providers (including ratings where available). Returns source URLs, metadata provenance and explicit gaps; no individual review-text feed or purchase. Use client web research for comments. Confirm edition/author before acquisition.",
      inputSchema: {
        workId: workIdSchema,
        title: z.string().min(1).max(500),
        author: z.string().max(500).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ workId, title, author }) =>
      guard(() => service.research(workId, title, author)),
  );
  server.registerTool(
    "procure_book",
    {
      description:
        "Queue an ebook acquisition for an explicitly selected work into an authorized BookOrbit library. Preview first, then repeat with dryRun=false and expectedState. Current upload permission is required; optional collection must be owned. Automatic source downloads/import may run after queueing; no paid checkout. Supports EPUB/PDF delivery. Idempotent per intent/account.",
      inputSchema: {
        workId: workIdSchema,
        title: z.string().trim().min(1).max(500),
        author: z.string().trim().min(1).max(500),
        language: z
          .string()
          .regex(/^[a-z]{2,3}$/)
          .default("en"),
        libraryId: z.number().int().positive(),
        collectionId: z.number().int().positive().optional(),
        allowUnverifiedMetadata: z
          .boolean()
          .default(false)
          .describe(
            "Allow missing PDF/EPUB metadata; conflicting title/author is always held for review",
          ),
        dryRun: z.boolean().default(true),
        expectedState: z
          .string()
          .regex(/^[a-f0-9]{64}$/)
          .optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async (input) => guard(() => service.create(input)),
  );
  server.registerTool(
    "find_book_releases",
    {
      description:
        "Inspect available releases and separate purchase offers for an acquisition job. Discerns source provenance for each release: acquisition source/provider (e.g. Project Gutenberg, Anna's Archive, Z-Library, torrent trackers), protocol (direct HTTP, torrent, usenet), file format (epub, pdf), size, quality score, and seeders. Optionally select resultId to start downloading that release. Current destination access checked. No source credentials or private URLs exposed.",
      inputSchema: {
        jobId: z.string().uuid(),
        resultId: z.number().int().positive().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ jobId, resultId }) => guard(() => service.releases(jobId, resultId)),
  );
  server.registerTool(
    "procurement_status",
    {
      description:
        "Track acquisition jobs and import completed EPUB/PDFs into their recorded authorized library. Reports acquisition source provenance (provider, protocol, format, release title) for selected and completed releases. cancel stops a pending request; retry_search retries an eligible owned source search after failure; reconcile_import with bookId attaches an existing native book only if destination and artifact hash match an uncertain upload. Index readiness is separate in get_index_status.",
      inputSchema: {
        jobId: z.string().uuid().optional(),
        action: z
          .enum(["status", "cancel", "retry_search", "reconcile_import"])
          .default("status"),
        bookId: z.number().int().positive().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ jobId, action, bookId }) =>
      guard(() => service.status(jobId, action, bookId)),
  );
}
