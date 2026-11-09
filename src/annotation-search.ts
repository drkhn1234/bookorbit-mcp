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

export async function searchOwnAnnotations(
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
