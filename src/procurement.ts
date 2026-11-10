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
};
const digest = (v: unknown) =>
  createHash("sha256")
    .update(Buffer.isBuffer(v) ? v : JSON.stringify(v))
    .digest("hex");
const workIdSchema = z
  .string()
  .regex(/^(openlibrary|hardcover|google_books):[A-Za-z0-9_-]{1,100}$/);
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

  async discover(query: string, limit: number) {
    const [external, owned] = await Promise.all([
      this.json(
        `/api/v1/search?${new URLSearchParams({ q: query, limit: String(limit) })}`,
      ),
      this.native.searchBooks(query, limit),
    ]);
    return {
      candidates: external.results,
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
    return {
      workId,
      retrievedAt: new Date().toISOString(),
      details: details.status === "fulfilled" ? details.value : null,
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
      // Native API omits credentialed artifact URLs; never surface filesystem paths.
      return {
        jobId,
        releases: response.search_results,
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
            if (!pdf && !epub) throw new Error("Artifact is not an EPUB/PDF container");
            const verification = await this.inspect({
              op: "inspect_acquisition",
              data: bytes.toString("base64"),
              title: job.title,
              author: job.author,
            });
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
              `acquisition-${job.id}.${pdf ? "pdf" : "epub"}`,
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
    "discover_books",
    {
      description:
        "Discover external books through Shelfarr and check only your accessible BookOrbit catalog. Translate conceptual questions into candidate title/author/subject searches. Not a full-text search of external books.",
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
        "Research a selected external work using Shelfarr descriptions and configured BookOrbit metadata providers (including ratings where available). Returns source URLs and explicit gaps; no individual review-text feed or purchase. Use client web research for comments. Confirm edition/author before acquisition.",
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
        "Inspect source releases and separate purchase offers for your own procurement job. Optionally select resultId to start that release; otherwise read-only. Current destination access checked. No source credentials or download URLs exposed.",
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
        "Track your own acquisition jobs and import completed EPUB/PDFs into their recorded authorized library. Background worker also imports. action=cancel stops a pending request, never deletes imported books. reconcile_import with bookId attaches an existing native book only if destination and artifact hash match an uncertain upload; no blind upload retry. Index readiness is separate in get_index_status.",
      inputSchema: {
        jobId: z.string().uuid().optional(),
        action: z.enum(["status", "cancel", "reconcile_import"]).default("status"),
        bookId: z.number().int().positive().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ jobId, action, bookId }) =>
      guard(() => service.status(jobId, action, bookId)),
  );
}
