import { createHash } from "node:crypto";
import { BookOrbitError, type BookOrbitClient } from "./bookorbit-client.js";
import { sourceFingerprint } from "./book-service.js";
import type { BookDetail, BookListItem, HubAnnotation } from "./types.js";
import type { KnowledgeWorker } from "./knowledge-worker.js";

const version = (note: HubAnnotation) =>
  createHash("sha256")
    .update(
      JSON.stringify([
        note.id,
        note.bookId,
        note.text,
        note.note,
        note.cfi,
        note.pageno,
        note.chapterTitle,
        note.chapterIndex,
        note.jumpFileId,
        note.deletedAt,
      ]),
    )
    .digest("hex");

async function legacySearchOwnAnnotations(
  client: BookOrbitClient,
  worker: Pick<KnowledgeWorker, "request">,
  query: string,
  catalog: BookListItem[],
  opts: { limit?: number; mode?: string } = {},
) {
  // Authenticated upstream ID, never an MCP argument or unverified JWT claim.
  const namespace = await client.annotationCacheNamespace();
  const allowed = new Map(catalog.map((b) => [b.id, b]));
  const notes: HubAnnotation[] = [];
  let total = 0;
  let scanned = 0;
  const bookIdFilter = catalog.length === 1 ? catalog[0].id : undefined;
  // Explicit bounded coverage; never label a first-page scan exhaustive.
  for (let page = 1; page <= 5; page++) {
    const response = await client.listAnnotations({
      page,
      pageSize: 100,
      bookId: bookIdFilter,
    });
    total = response.total;
    scanned += response.items.length;
    notes.push(...response.items.filter((n) => allowed.has(n.bookId) && !n.deletedAt));
    if (scanned >= total || !response.items.length) break;
  }
  const byId = new Map(notes.map((n) => [n.id, n]));
  const ranked = await worker.request<
    { id: number; version: string; score: number; semanticSimilarity: number | null }[]
  >({
    op: "search_notes",
    namespace,
    snapshotComplete: bookIdFilter === undefined && scanned >= total,
    query,
    mode: opts.mode ?? "hybrid",
    limit: Math.min(100, (opts.limit ?? 10) * 3),
    items: notes.map((n) => ({
      id: n.id,
      version: version(n),
      text: `${n.text ?? ""}\n${n.note ?? ""}`.slice(0, 4000),
    })),
  });
  // Fetch candidate books' active own notes again after embedding. A deleted or
  // edited candidate is omitted immediately, even if its old vector is cached.
  const currentByBook = new Map<number, Map<number, HubAnnotation>>();
  const annotations = [];
  for (const row of ranked) {
    const note = byId.get(row.id);
    if (!note || version(note) !== row.version) continue;
    try {
      const book = await client.getBook(note.bookId);
      const fingerprint = sourceFingerprint(book);
      if (fingerprint !== sourceFingerprint(allowed.get(book.id)! as BookDetail))
        continue;
      let current = currentByBook.get(book.id);
      if (!current) {
        current = new Map();
        for (let page = 1; page <= 20; page++) {
          const response = await client.listAnnotations({
            bookId: book.id,
            page,
            pageSize: 100,
          });
          for (const n of response.items) if (!n.deletedAt) current.set(n.id, n);
          if (page * response.pageSize >= response.total || !response.items.length) break;
        }
        currentByBook.set(book.id, current);
      }
      const live = current.get(note.id);
      if (!live || version(live) !== row.version) continue;
      if (sourceFingerprint(await client.getBook(book.id)) !== fingerprint) continue;
      const origin = process.env.PUBLIC_URL?.replace(/\/+$/, "");
      annotations.push({
        id: live.id,
        bookId: live.bookId,
        title: book.title,
        text: live.text?.slice(0, 8000),
        note: live.note?.slice(0, 8000),
        textTruncated: (live.text?.length ?? 0) > 8000 || (live.note?.length ?? 0) > 8000,
        chapter: live.chapterTitle,
        page: live.pageno,
        cfi: live.cfi,
        location: {
          readerChapterIndex: live.chapterIndex,
          jumpFileId: live.jumpFileId,
          positionStatus: live.positionStatus,
          origin: live.origin,
          caution:
            "Reader-provided location; chapter index is not an MCP section index; page numbering is not inferred",
        },
        sourceLookup: live.text
          ? {
              tool: "search_passages",
              arguments: {
                query: live.text.slice(0, 1000),
                bookIds: [book.id],
                mode: "lexical",
                limit: 3,
              },
              caution: "Text match suggestion only; not a certified source anchor",
            }
          : null,
        annotationVersion: row.version,
        sourceVersion: fingerprint,
        bookUrl: origin ? `${origin}/book/${book.id}` : null,
        score: row.score,
        semanticSimilarity: row.semanticSimilarity,
      });
      if (annotations.length >= (opts.limit ?? 10)) break;
    } catch (error) {
      if (!(error instanceof BookOrbitError) || ![403, 404].includes(error.status))
        throw error;
    }
  }
  return {
    annotations,
    coverage: {
      scanned,
      totalOwnAnnotations: total,
      truncated: scanned < total,
      embeddingTextLimit: 4000,
      scope: "live-own-notes-current-authorized-books",
      cache: "persistent-user-scoped-vectors-live-note-snapshot",
    },
  };
}

export function atomicAnnotationIndexEnabled(): boolean {
  const selected = process.env.ANNOTATION_INDEX ?? "legacy";
  if (!["legacy", "lancedb"].includes(selected))
    throw new Error("ANNOTATION_INDEX must be legacy or lancedb");
  return selected === "lancedb";
}

/** Exhaust current native pages; no recent-500 shortcut or persisted grants. */
async function ownSnapshot(client: BookOrbitClient, bookId?: number) {
  const notes = new Map<number, HubAnnotation>();
  let scanned = 0,
    total = 0,
    stable = true;
  let bytes = 0;
  for (let page = 1; page <= 500; page++) {
    const response = await client.listAnnotations({ page, pageSize: 100, bookId });
    if (!Number.isSafeInteger(response.total) || response.total < 0)
      throw new Error("Invalid annotation pagination total");
    if (page > 1 && response.total !== total) stable = false;
    total = response.total;
    let added = 0;
    for (const note of response.items) {
      bytes += Buffer.byteLength(note.text ?? "") + Buffer.byteLength(note.note ?? "");
      if (bytes > 64 * 1024 * 1024)
        throw new Error("Annotation snapshot exceeds 64 MiB; narrow book scope");
      if (!notes.has(note.id)) added++;
      notes.set(note.id, note);
    }
    scanned += response.items.length;
    if (!response.items.length || scanned >= total)
      return {
        notes: [...notes.values()],
        scanned: notes.size,
        total,
        complete: stable && notes.size === total,
      };
    if (!added) throw new Error("Annotation pagination repeated a page; retry sync");
  }
  throw new Error("Annotation snapshot exceeds 50000 records; narrow book scope");
}

function atomicId(namespace: string, id: number, kind: string) {
  // Match Python json.dumps' default separators exactly; owner and kind are ASCII.
  return createHash("sha256").update(`["${namespace}", ${id}, "${kind}"]`).digest("hex");
}

type AtomicUnit = {
  annotationId: number;
  bookId: number;
  libraryId: number;
  kind: string;
  text: string;
  version: string;
  sourceVersion: string;
  page: number | null;
  cfi: string | null;
  chapter: string | null;
  chapterIndex: number | null;
  fileId: number | null;
  origin: string | null;
  positionStatus: string | null;
  createdAt: string | null;
};
type AtomicHit = {
  id: number;
  unitId: string;
  kind: string;
  version: string;
  score: number;
  semanticSimilarity: number | null;
  embeddingProvenance?: string;
  sourceLinks?: {
    passageId: string;
    sourceVersion: string;
    section: number;
    charStart: number;
    charEnd: number;
    method: string;
  }[];
};

async function prepareAtomicSnapshot(client: BookOrbitClient, catalog: BookListItem[]) {
  const namespace = await client.annotationCacheNamespace();
  const snapshot = await ownSnapshot(
    client,
    catalog.length === 1 ? catalog[0].id : undefined,
  );
  const allowed = new Map(catalog.map((b) => [b.id, b]));
  const books = new Map<number, BookDetail>();
  const notes = snapshot.notes.filter((n) => !n.deletedAt && allowed.has(n.bookId));
  for (const id of new Set(notes.map((n) => n.bookId))) {
    try {
      const book = await client.getBook(id);
      if (book.libraryId === allowed.get(id)!.libraryId) books.set(id, book);
    } catch (error) {
      if (!(error instanceof BookOrbitError) || ![403, 404].includes(error.status))
        throw error;
    }
  }
  const units: AtomicUnit[] = [];
  for (const note of notes) {
    const book = books.get(note.bookId);
    if (!book || book.libraryId == null) continue;
    for (const [kind, text] of [
      ["highlight", note.text],
      ["note", note.note],
    ]) {
      if (typeof text !== "string" || !text.trim()) continue;
      units.push({
        annotationId: note.id,
        bookId: book.id,
        libraryId: book.libraryId,
        kind: kind!,
        text,
        version: version(note),
        sourceVersion: sourceFingerprint(book),
        page: note.pageno ?? null,
        cfi: note.cfi ?? null,
        chapter: note.chapterTitle ?? null,
        chapterIndex: note.chapterIndex ?? null,
        fileId: note.jumpFileId ?? null,
        origin: note.origin ?? null,
        positionStatus: note.positionStatus ?? null,
        createdAt: note.createdAt ?? null,
      });
    }
  }
  return { namespace, snapshot, notes, books, units };
}

async function synchronizeAtomic(
  worker: Pick<KnowledgeWorker, "request">,
  prepared: Awaited<ReturnType<typeof prepareAtomicSnapshot>>,
  completeScope: boolean,
) {
  let indexed = 0,
    reused = 0;
  const errors: { annotationId: number; kind: string; error: string }[] = [];
  for (let start = 0; start < prepared.units.length; start += 100) {
    const result = await worker.request<{
      indexed: number;
      reused: number;
      errors: typeof errors;
    }>({
      op: "annotation_sync",
      namespace: prepared.namespace,
      items: prepared.units.slice(start, start + 100),
      scanned: prepared.snapshot.scanned,
      total: prepared.snapshot.total,
    });
    indexed += result.indexed;
    reused += result.reused;
    errors.push(...result.errors);
  }
  await worker.request({
    op: "annotation_finish",
    namespace: prepared.namespace,
    currentIds: prepared.units.map((u) =>
      atomicId(prepared.namespace, u.annotationId, u.kind),
    ),
    snapshotComplete: completeScope && prepared.snapshot.complete,
    scanned: prepared.snapshot.scanned,
    total: prepared.snapshot.total,
  });
  return { indexed, reused, errors };
}

/** Background sync uses the same authenticated snapshots and resumable unit upserts. */
export async function syncOwnAnnotationIndex(
  client: BookOrbitClient,
  worker: Pick<KnowledgeWorker, "request">,
  catalog: BookListItem[],
) {
  if (!atomicAnnotationIndexEnabled()) return null;
  return synchronizeAtomic(worker, await prepareAtomicSnapshot(client, catalog), true);
}

export async function searchOwnAnnotations(
  client: BookOrbitClient,
  worker: Pick<KnowledgeWorker, "request">,
  query: string,
  catalog: BookListItem[],
  opts: { limit?: number; mode?: string; bookIds?: number[]; libraryIds?: number[] } = {},
) {
  if (!atomicAnnotationIndexEnabled())
    return legacySearchOwnAnnotations(client, worker, query, catalog, opts);
  const prepared = await prepareAtomicSnapshot(client, catalog);
  const { namespace, snapshot, notes, books, units } = prepared;
  const mode = opts.mode ?? "hybrid";
  // Lexical-only calls do not request embeddings or write private text to LanceDB.
  const sync =
    mode === "lexical"
      ? { indexed: 0, reused: 0, errors: [] }
      : await synchronizeAtomic(worker, prepared, !opts.bookIds && !opts.libraryIds);
  const liveUnits = units.map((u) => ({
    id: atomicId(namespace, u.annotationId, u.kind),
    bookId: u.bookId,
    sourceVersion: u.sourceVersion,
    version: u.version,
  }));
  let ranked: AtomicHit[];
  if (mode === "lexical") {
    const tokens = new Set(query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);
    ranked = units
      .map((u) => ({
        id: u.annotationId,
        unitId: atomicId(namespace, u.annotationId, u.kind),
        kind: u.kind,
        version: u.version,
        semanticSimilarity: null,
        score: [...new Set(u.text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])].filter(
          (t) => tokens.has(t),
        ).length,
      }))
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score);
  } else {
    ranked = await worker.request<AtomicHit[]>({
      op: "annotation_search",
      namespace,
      query,
      mode,
      limit: Math.min(100, (opts.limit ?? 10) * 3),
      items: liveUnits,
    });
  }
  const byId = new Map(notes.map((n) => [n.id, n]));
  const currentByBook = new Map<number, Map<number, HubAnnotation>>();
  const annotations = [];
  const returned = new Set<number>();
  for (const row of ranked) {
    if (returned.has(row.id)) continue;
    const note = byId.get(row.id),
      original = note && books.get(note.bookId);
    if (!note || !original || version(note) !== row.version) continue;
    try {
      const book = await client.getBook(note.bookId);
      const fingerprint = sourceFingerprint(book);
      if (fingerprint !== sourceFingerprint(original)) continue;
      let current = currentByBook.get(book.id);
      if (!current) {
        current = new Map(
          (await ownSnapshot(client, book.id)).notes
            .filter((n) => !n.deletedAt)
            .map((n) => [n.id, n]),
        );
        currentByBook.set(book.id, current);
      }
      const live = current.get(note.id);
      if (!live || version(live) !== row.version) continue;
      if (sourceFingerprint(await client.getBook(book.id)) !== fingerprint) continue;
      const origin = process.env.PUBLIC_URL?.replace(/\/+$/, "");
      const matches = ranked.filter((r) => r.id === row.id && r.version === row.version);
      annotations.push({
        id: live.id,
        bookId: live.bookId,
        title: book.title || "Untitled",
        text: live.text?.slice(0, 8000),
        note: live.note?.slice(0, 8000),
        textTruncated: (live.text?.length ?? 0) > 8000 || (live.note?.length ?? 0) > 8000,
        chapter: live.chapterTitle,
        page: live.pageno,
        cfi: live.cfi,
        location: {
          readerChapterIndex: live.chapterIndex,
          jumpFileId: live.jumpFileId,
          positionStatus: live.positionStatus,
          origin: live.origin,
          caution:
            "Native reader location; no invented print pagination or MCP section mapping",
        },
        matchedUnits: matches.map((r) => ({
          unitId: r.unitId,
          kind: r.kind,
          score: r.score,
          semanticSimilarity: r.semanticSimilarity,
          embeddingProvenance: r.embeddingProvenance,
        })),
        sourceLinks: matches
          .flatMap((r) => r.sourceLinks ?? [])
          .map((link) => ({
            ...link,
            navigation: {
              tool: "get_passage",
              arguments: {
                bookId: book.id,
                passageId: link.passageId,
                sourceVersion: fingerprint,
              },
            },
          })),
        sourceLookup: live.text
          ? {
              tool: "search_passages",
              arguments: {
                query: live.text.slice(0, 1000),
                bookIds: [book.id],
                mode: "lexical",
                limit: 3,
              },
              caution:
                "Suggestion only; verified source links, when available, are listed separately",
            }
          : null,
        annotationVersion: row.version,
        sourceVersion: fingerprint,
        bookUrl: origin ? `${origin}/book/${book.id}` : null,
        score: row.score,
        semanticSimilarity: row.semanticSimilarity,
      });
      returned.add(row.id);
      if (annotations.length >= (opts.limit ?? 10)) break;
    } catch (error) {
      if (!(error instanceof BookOrbitError) || ![403, 404].includes(error.status))
        throw error;
    }
  }
  return {
    annotations,
    coverage: {
      scanned: snapshot.scanned,
      totalOwnAnnotations: snapshot.total,
      truncated: !snapshot.complete,
      atomicUnits: units.length,
      embeddingTextLimit: null,
      indexingRequested: mode !== "lexical",
      indexedOrReusedUnits: mode === "lexical" ? 0 : units.length - sync.errors.length,
      unindexedUnits: sync.errors,
      scope: "live-own-notes-current-authorized-books",
      cache: "lancedb-atomic-units-live-note-snapshot",
    },
  };
}
