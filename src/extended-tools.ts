import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { BookOrbitClient } from "./bookorbit-client.js";
import { sourceFingerprint, type BookService } from "./book-service.js";
import { indexingWorker, knowledgeWorker } from "./knowledge-worker.js";
import { KnowledgeService } from "./knowledge-service.js";
import { registerOrganizationTools } from "./organization.js";

const id = z.number().int().positive();
const readOnly = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
const result = (data: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(data) }],
});
const guard = async (fn: () => Promise<unknown>) => {
  try {
    return result(await fn());
  } catch (error) {
    return { ...result({ error: (error as Error).message }), isError: true };
  }
};
const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

export function registerExtendedTools(
  server: McpServer,
  client: BookOrbitClient,
  books: BookService,
) {
  registerOrganizationTools(server, client);
  const knowledge = new KnowledgeService(
    client,
    books,
    process.env.CACHE_DIR ?? join(homedir(), ".cache", "bookorbit-mcp"),
  );
  server.registerTool(
    "maintenance_report",
    {
      description:
        "Read-only exception report for your currently accessible books: indexing failures/pending work, missing catalog metadata, possible duplicates, native import automation and permitted metadata queue counts. No automatic deletion, rename or metadata overwrites. Reports are also saved privately by the background worker when enabled; this tool always refreshes native access.",
      annotations: readOnly,
      inputSchema: {},
    },
    async () => guard(() => knowledge.maintenanceReport()),
  );
  server.registerTool(
    "get_passage",
    {
      description:
        "Resolve an exact versioned search_passages citation and up to two adjacent chunks on each side in the same section/page. Rejects stale source versions and inaccessible books. Context chunks may overlap. No invented print pages or EPUB CFIs.",
      annotations: readOnly,
      inputSchema: {
        bookId: id,
        passageId: z.string().regex(/^[a-f0-9]{64}$/),
        sourceVersion: z.string().regex(/^[a-f0-9]{64}$/),
        context: z.number().int().min(0).max(2).default(1),
      },
    },
    async ({ bookId, passageId, sourceVersion, context }) =>
      guard(() => knowledge.passage(bookId, passageId, sourceVersion, context)),
  );
  server.registerTool(
    "search_annotations",
    {
      description:
        "Semantic, lexical or hybrid search of your own live highlights and notes in currently accessible books. Reports actual scan/index coverage and rechecks edits/deletions/access before returning. When enabled, the atomic LanceDB index scans all native pages and embeds highlights/comments separately; legacy mode reports its 500-note cap. BookOrbit remains authoritative. Reader locations are not invented MCP section indices.",
      annotations: readOnly,
      inputSchema: {
        query: z.string().trim().min(1).max(1000),
        bookIds: z.array(id).min(1).max(200).optional(),
        libraryIds: z.array(id).min(1).max(50).optional(),
        limit: id.max(20).default(10),
        mode: z.enum(["hybrid", "semantic", "lexical"]).default("hybrid"),
      },
    },
    async ({ query, ...opts }) => guard(() => knowledge.searchAnnotations(query, opts)),
  );
  server.registerTool(
    "inspect_book",
    {
      description:
        "Inspect a bounded window of an authorized EPUB or PDF even before semantic indexing. start is a 1-based EPUB section or PDF page, count at most 5. Returns source locations, optional query-centered excerpts and nextStart. This is not full-book search; use list_chapters for EPUB navigation. Set prioritize=true to queue durable priority indexing.",
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      inputSchema: {
        bookId: id,
        start: id.default(1),
        count: id.max(5).default(3),
        query: z.string().max(1000).default(""),
        prioritize: z.boolean().default(false),
      },
    },
    async ({ bookId, start, count, query, prioritize }) =>
      guard(async () => {
        const inspected = await knowledge.inspect(bookId, start, count, query);
        if (prioritize)
          await knowledgeWorker.request({
            op: "job_control",
            fingerprint: sourceFingerprint(await client.getBook(bookId)),
            bookId,
            action: "queue",
            priority: 100,
          });
        return { ...inspected, indexingPrioritized: prioritize };
      }),
  );
  server.registerTool(
    "control_indexing",
    {
      description:
        "Manage a durable per-book index job: pause at next embedding batch, resume, retry, or prioritize. Requires native metadata-management permission plus current book access. Controls affect the shared derived job for that book; never change original content. Progress/errors are in get_index_status. Priority applies after the current book yields.",
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      inputSchema: {
        bookId: id,
        action: z.enum(["pause", "resume", "retry", "prioritize"]),
        priority: z.number().int().min(0).max(100).default(100),
      },
    },
    async ({ bookId, action, priority }) =>
      guard(async () => {
        const book = await client.getBook(bookId);
        if (book.libraryId == null) throw new Error("Missing library identity");
        await client.getFetchConfig(book.libraryId);
        return knowledgeWorker.request({
          op: "job_control",
          bookId,
          fingerprint: sourceFingerprint(book),
          action: action === "prioritize" ? "queue" : action,
          priority,
        });
      }),
  );
  server.registerTool(
    "list_books",
    {
      description:
        "Browse the current account's authorized catalog with pagination. Optional libraryId narrows to one accessible library. Lists PDF/EPUB files and metadata; no server filesystem paths.",
      annotations: readOnly,
      inputSchema: {
        page: z.number().int().min(0).max(499).default(0),
        size: id.max(100).default(50),
        libraryId: id.optional(),
      },
    },
    async ({ page, size, libraryId }) =>
      guard(async () => {
        const result = await client.queryBooks(page, size, libraryId);
        return {
          ...result,
          items: result.items.map((b) => ({
            id: b.id,
            libraryId: b.libraryId,
            title: b.title,
            authors: b.authors,
            updatedAt: b.updatedAt,
            files: b.files?.map((f) => ({
              id: f.id,
              format: f.format,
              sizeBytes: f.sizeBytes,
            })),
          })),
        };
      }),
  );
  server.registerTool(
    "read_pdf_pages",
    {
      description:
        "Read a PDF by 1-based page numbers, with page citations. Extracts text and uses local OCR for scanned pages when available. Does not modify the PDF. Results are capped; paginate using nextOffset/nextPage.",
      annotations: readOnly,
      inputSchema: {
        bookId: id,
        startPage: id.optional(),
        pageCount: id.max(5).optional(),
        offset: z.number().int().min(0).optional(),
        maxChars: id.max(40000).optional(),
        layoutAware: z.boolean().default(false),
      },
    },
    async ({
      bookId,
      startPage = 1,
      pageCount = 1,
      offset = 0,
      maxChars = 20000,
      layoutAware,
    }) =>
      guard(async () => {
        const { book, document } = layoutAware
          ? await knowledge.readPdfWindow(bookId, startPage, pageCount)
          : await knowledge.pdf(bookId);
        const totalPages = document.totalPages ?? document.sections.length;
        if (startPage > totalPages) throw new Error("Page outside PDF");
        let remaining = maxChars;
        const pages: {
          page: number | undefined;
          text: string;
          charOffset: number;
          nextOffset: number | null;
        }[] = [];
        for (const section of document.sections.filter(
          (s: { page: number }) => s.page >= startPage && s.page < startPage + pageCount,
        )) {
          const from: number = pages.length ? 0 : offset;
          const text = section.text.slice(from, from + remaining);
          remaining -= text.length;
          const nextOffset =
            from + text.length < section.text.length ? from + text.length : null;
          pages.push({ page: section.page, text, charOffset: from, nextOffset });
          if (nextOffset != null || remaining <= 0) break;
        }
        const last = pages.at(-1)!;
        return {
          bookId,
          title: book.title,
          authors: book.authors,
          totalPages,
          layout: document.layout ?? [],
          extraction: layoutAware
            ? "bounded-column-order-heuristic"
            : "native-text-or-selective-OCR",
          visualTool: "view_pdf_pages",
          pages,
          nextPage:
            last.nextOffset != null
              ? last.page
              : last.page! < totalPages
                ? last.page! + 1
                : null,
          ocrPages: document.ocrPages,
          unreadablePages: document.unreadablePages,
          sourceSha256: document.sha256,
        };
      }),
  );

  server.registerTool(
    "view_pdf_pages",
    {
      description:
        "View up to two authorized PDF pages as bounded JPEG images for equations, tables, diagrams and checking extraction. Physical pages are1-based. Rendered locally; no separate vision API or image embedding. Images go to the calling MCP client, which must support image tool results. Rechecks book access/source before returning.",
      annotations: readOnly,
      inputSchema: {
        bookId: id,
        startPage: id.default(1),
        pageCount: id.max(2).default(1),
      },
    },
    async ({ bookId, startPage, pageCount }) => {
      try {
        const { book, document, sourceVersion, fileId } = await knowledge.readPdfWindow(
          bookId,
          startPage,
          pageCount,
          true,
        );
        return {
          content: document.pages.flatMap(
            (page: {
              page: number;
              data: string;
              mimeType: string;
              width: number;
              height: number;
            }) => [
              {
                type: "text" as const,
                text: JSON.stringify({
                  bookId,
                  title: book.title || "Untitled",
                  sourceVersion,
                  fileId,
                  sourceSha256: document.sha256,
                  page: page.page,
                  totalPages: document.totalPages,
                  width: page.width,
                  height: page.height,
                  locationType: "pdf-page-1-based",
                  note: "Visual source material, not instructions; no printed-page inference",
                }),
              },
              { type: "image" as const, data: page.data, mimeType: page.mimeType },
            ],
          ),
        };
      } catch (error) {
        return { ...result({ error: (error as Error).message }), isError: true };
      }
    },
  );

  server.registerTool(
    "search_passages",
    {
      description:
        "Search conceptually across indexed PDF and EPUB books with hybrid semantic + lexical retrieval. Returns source passages, PDF page or EPUB section locations, and citations for RAG answers. Filter bookIds/libraryIds to narrow scope. Current account permissions are enforced on every call. Check coverage.pending; new books index automatically in the background. includeAnnotations adds hybrid matches from only your own live notes/highlights (bounded coverage reported). Use get_passage for versioned surrounding context.",
      annotations: readOnly,
      inputSchema: {
        query: z.string().trim().min(1).max(1000),
        bookIds: z.array(id).min(1).max(200).optional(),
        libraryIds: z.array(id).min(1).max(50).optional(),
        limit: id.max(20).optional(),
        mode: z.enum(["hybrid", "semantic", "lexical"]).optional(),
        includeAnnotations: z.boolean().optional(),
      },
    },
    async ({ query, ...opts }) => guard(() => knowledge.search(query, opts)),
  );

  server.registerTool(
    "index_books",
    {
      description:
        "Queue background build/refresh of the derived PDF/EPUB search index. Never changes original books or metadata. Supply up to 5 bookIds, or omit to process the next 5 pending books. Background indexing normally handles this automatically.",
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputSchema: { bookIds: z.array(id).min(1).max(5).optional() },
    },
    async ({ bookIds }) =>
      guard(async () => {
        const ids = bookIds ?? (await knowledge.status()).pending.slice(0, 5);
        for (const bookId of ids) await client.getBook(bookId);
        for (const bookId of ids)
          await knowledgeWorker.request({
            op: "job_control",
            fingerprint: sourceFingerprint(await client.getBook(bookId)),
            bookId,
            action: "queue",
            priority: 100,
          });
        const background = new KnowledgeService(
          client,
          books,
          process.env.CACHE_DIR ?? join(homedir(), ".cache", "bookorbit-mcp"),
          indexingWorker,
        );
        void (async () => {
          for (let n = 0; n < ids.length; n++) await background.indexPending(1, ids);
        })().catch(() => console.error("[Index] scheduler retry required"));
        return {
          queued: ids,
          note: "Indexing runs in the background. Use get_index_status; completed embedding batches survive interruption.",
        };
      }),
  );
  server.registerTool(
    "get_index_status",
    {
      description:
        "Index coverage for only the current user's accessible catalog: model, indexed/pending EPUB/PDF books and unsupported formats.",
      annotations: readOnly,
      inputSchema: {},
    },
    async () => guard(() => knowledge.status()),
  );

  server.registerTool(
    "library_maintenance",
    {
      description:
        "Inspect or automate one BookOrbit library using its native API and permissions. report shows watched-folder, naming and metadata-fetch settings; rename_preview previews native file organization; organize executes native renaming only for explicit bookIds. configure can enable watching and metadata on import, and set a naming pattern/automatic rename. fetch_metadata queues native provider enrichment with existing locks/policies. Writes default to dryRun; inspect preview then repeat with dryRun=false and its expectedState. Never deletes books, grants access or rewrites file bytes. Renaming is performed only by BookOrbit.",
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
      inputSchema: {
        libraryId: id,
        action: z
          .enum(["report", "configure", "fetch_metadata", "rename_preview", "organize"])
          .default("report"),
        bookIds: z.array(id).min(1).max(50).optional(),
        watch: z.boolean().optional(),
        metadataOnImport: z.boolean().optional(),
        namingPattern: z.string().min(1).max(500).optional(),
        renameAfterMetadata: z.boolean().optional(),
        dryRun: z.boolean().default(true),
        expectedState: z
          .string()
          .regex(/^[a-f0-9]{64}$/)
          .optional(),
      },
    },
    async ({
      libraryId,
      action,
      watch,
      bookIds,
      metadataOnImport,
      namingPattern,
      renameAfterMetadata,
      dryRun,
      expectedState,
    }) =>
      guard(async () => {
        const library = await client.getLibrary(libraryId);
        if (action === "rename_preview") return client.previewRename(libraryId);
        const config = await client.getFetchConfig(libraryId);
        const state = {
          libraryId,
          watch: library.watch,
          autoScanCronExpression: library.autoScanCronExpression,
          fileNamingPattern: library.fileNamingPattern,
          fileRenameEnabled: library.fileRenameEnabled,
          metadata: config,
        };
        const expected = hash(state);
        if (action === "report")
          return {
            ...state,
            expectedState: expected,
            queue: await client.getFetchStatus(),
          };
        const libraryPatch = {
          ...(watch == null ? {} : { watch }),
          ...(namingPattern == null ? {} : { fileNamingPattern: namingPattern }),
          ...(renameAfterMetadata == null
            ? {}
            : { fileRenameEnabled: renameAfterMetadata }),
        };
        const metadataPatch =
          metadataOnImport == null
            ? undefined
            : { enabled: metadataOnImport, triggerOnImport: metadataOnImport };
        if (dryRun)
          return {
            dryRun: true,
            expectedState: expected,
            current: state,
            changes:
              action === "configure"
                ? { libraryPatch, metadataPatch }
                : action === "organize"
                  ? {
                      organizeBookIds: bookIds,
                      preview: await client.previewRename(libraryId),
                    }
                  : { enqueueNativeMetadata: true },
          };
        if (expectedState !== expected)
          throw new Error(
            "State changed or preview missing; run dryRun and use its expectedState",
          );
        if (action === "fetch_metadata") return client.fetchMetadata(libraryId);
        if (action === "organize") {
          if (!bookIds?.length)
            throw new Error(
              "Organize requires an explicit list of up to 50 bookIds; inspect rename_preview first",
            );
          for (const bookId of bookIds) {
            const book = await client.getBook(bookId);
            if (book.libraryId !== libraryId)
              throw new Error("Book is not in the selected library");
          }
          const events = await client.organizeBooks(libraryId, bookIds);
          return { events: events.slice(-10), eventCount: events.length };
        }
        // Per-library configuration consists of separate native transactions. Report
        // partial failure explicitly; retry with a fresh preview rather than rolling
        // back over concurrent administrator edits.
        let metadataApplied = false;
        try {
          if (metadataPatch) {
            await client.updateFetchConfig(libraryId, metadataPatch);
            metadataApplied = true;
          }
          if (Object.keys(libraryPatch).length)
            await client.updateLibrary(libraryId, libraryPatch);
          return { applied: true, libraryId, libraryPatch, metadataPatch };
        } catch (error) {
          throw new Error(
            `Configuration failed; metadataApplied=${metadataApplied}; refresh report before retry: ${(error as Error).message}`,
            { cause: error },
          );
        }
      }),
  );

  server.registerTool(
    "search_book_metadata",
    {
      description:
        "Search BookOrbit's configured external book-metadata providers for bibliographic/cover candidates. Read-only: does not apply candidates or invent metadata. Use update_book_metadata to fill selected fields, or library_maintenance for automatic native provider enrichment.",
      annotations: { ...readOnly, openWorldHint: true },
      inputSchema: {
        title: z.string().trim().min(1).max(500),
        author: z.string().max(500).optional(),
        isbn: z
          .string()
          .regex(/^[0-9Xx-]{10,20}$/)
          .optional(),
      },
    },
    async ({ title, author, isbn }) =>
      guard(async () => ({
        events: await client.searchBookMetadata(title, author, isbn),
      })),
  );

  const patch = z
    .object({
      title: z.string().min(1).max(1000).optional(),
      authors: z.array(z.string().min(1)).min(1).max(30).optional(),
      description: z.string().max(50000).optional(),
      publisher: z.string().max(500).optional(),
      language: z.string().max(35).optional(),
      publishedYear: z.number().int().min(0).max(9999).optional(),
      seriesName: z.string().max(1000).optional(),
      seriesIndex: z.number().nonnegative().optional(),
      isbn13: z
        .string()
        .regex(/^\d{13}$/)
        .optional(),
      genres: z.array(z.string().min(1)).max(100).optional(),
      tags: z.array(z.string().min(1)).max(100).optional(),
    })
    .strict();
  server.registerTool(
    "update_book_metadata",
    {
      description:
        "Update selected book metadata through BookOrbit. Defaults to filling empty fields only and dry-run. Review preview, then use dryRun=false with expectedState. overwrite=true replaces existing fields explicitly; native locked fields are always skipped. Existing library automatic write/rename policies may run on save. No delete or direct filesystem access.",
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
      inputSchema: {
        bookId: id,
        patch,
        overwrite: z.boolean().default(false),
        dryRun: z.boolean().default(true),
        expectedState: z.string().optional(),
      },
    },
    async ({ bookId, patch, overwrite, dryRun, expectedState }) =>
      guard(async () => {
        const book = await client.getBook(bookId);
        const current = book as unknown as Record<string, unknown>;
        const locked = new Set(
          Array.isArray(current.lockedFields) ? current.lockedFields : [],
        );
        if (locked.has("seriesName") || locked.has("seriesIndex")) {
          locked.add("seriesName");
          locked.add("seriesIndex");
        }
        const changes = Object.fromEntries(
          Object.entries(patch).filter(
            ([key]) =>
              !locked.has(key) &&
              (overwrite ||
                current[key] == null ||
                current[key] === "" ||
                (Array.isArray(current[key]) && !current[key].length)),
          ),
        );
        const expected = hash(book);
        if (dryRun)
          return {
            dryRun,
            bookId,
            changes,
            skipped: Object.keys(patch).filter((key) => !(key in changes)),
            skippedLocked: Object.keys(patch).filter((key) => locked.has(key)),
            expectedState: expected,
          };
        if (expectedState !== expected)
          throw new Error("Book changed or preview missing; run a fresh dryRun");
        if (!Object.keys(changes).length)
          return { applied: false, reason: "No empty fields to fill" };
        await client.updateMetadata(bookId, changes);
        return { applied: true, bookId, changes };
      }),
  );

  server.registerTool(
    "audit_library",
    {
      description:
        "Find missing metadata and likely title/author duplicates in an accessible library. Read-only; duplicates are suggestions, never automatically deleted. Paginated catalog scan, capped at 10000 books. Use library_maintenance for native enrichment/organization.",
      annotations: readOnly,
      inputSchema: { libraryId: id, maxIssues: id.max(100).default(30) },
    },
    async ({ libraryId, maxIssues }) =>
      guard(async () => {
        await client.getLibrary(libraryId);
        const missing = [];
        const duplicates = [];
        const seen = new Map<string, number>();
        let scanned = 0;
        let total = 0;
        for (let page = 0; page < 100; page++) {
          const response = await client.queryBooks(page, 100, libraryId);
          total = response.total;
          for (const book of response.items) {
            scanned++;
            const fields = [
              !book.title ? "title" : null,
              !book.authors?.length ? "authors" : null,
              !book.language ? "language" : null,
              !book.publishedYear ? "publishedYear" : null,
            ].filter(Boolean);
            if (fields.length && missing.length < maxIssues)
              missing.push({ bookId: book.id, title: book.title, fields });
            const key = `${book.title
              ?.normalize("NFKC")
              .toLowerCase()
              .replace(
                /[^\p{L}\p{N}]/gu,
                "",
              )}:${[...(book.authors ?? [])].sort().join("|").toLowerCase()}`;
            if (book.title && book.authors?.length) {
              if (seen.has(key) && duplicates.length < maxIssues)
                duplicates.push({
                  bookIds: [seen.get(key), book.id],
                  title: book.title,
                  confidence: "title-author-match-review-required",
                });
              else seen.set(key, book.id);
            }
          }
          if (scanned >= total || !response.items.length) break;
        }
        return {
          libraryId,
          scanned,
          total,
          complete: scanned >= total,
          missing,
          possibleDuplicates: duplicates,
        };
      }),
  );
}
