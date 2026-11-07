import type { BookDetail } from "./types.js";
import type { Passage } from "./knowledge-service.js";

/** Source-versioned identity; offsets refer to extracted text, never print pagination. */
export function passageCitation(book: BookDetail, row: Passage) {
  const origin = process.env.PUBLIC_URL?.replace(/\/+$/, "");
  return {
    passageId: row.id,
    sourceVersion: row.fingerprint,
    bookId: book.id,
    title: book.title,
    authors: book.authors,
    libraryId: book.libraryId,
    sectionIndex: row.section,
    section: row.label,
    page: row.page || null,
    charStart: row.char_start,
    charEnd: row.char_end,
    passageSha256: row.sha256,
    metadataPath: `/api/v1/books/${book.id}`,
    bookUrl: origin ? `${origin}/book/${book.id}` : null,
    locationType: row.page ? "pdf-page-1-based" : "epub-section-character-offset",
    navigation: {
      tool: "get_passage",
      arguments: { bookId: book.id, passageId: row.id, sourceVersion: row.fingerprint },
    },
    inspection: {
      tool: "inspect_book",
      arguments: { bookId: book.id, start: row.page || row.section + 1, count: 1 },
    },
  };
}
