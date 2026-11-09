import { BookOrbitError, type BookOrbitClient } from "./bookorbit-client.js";
import type { BookListItem } from "./types.js";

/** Read-only exception aggregation; current native access supplies every candidate. */
export async function maintenanceReport(
  client: BookOrbitClient,
  catalog: BookListItem[],
  indexing: { indexed: number; pending: number[]; jobs: any[]; annotations?: unknown },
) {
  const missing = [],
    duplicates = [];
  const seen = new Map<string, number>();
  for (const book of catalog) {
    const fields = [
      !book.title && "title",
      !book.authors?.length && "authors",
      !book.language && "language",
      !book.publishedYear && "publishedYear",
    ].filter(Boolean);
    if (fields.length) missing.push({ bookId: book.id, fields });
    const key = `${book.title
      ?.normalize("NFKC")
      .toLowerCase()
      .replace(
        /[^\p{L}\p{N}]/gu,
        "",
      )}:${[...(book.authors ?? [])].sort().join("|").toLowerCase()}`;
    if (book.title && book.authors?.length) {
      if (seen.has(key))
        duplicates.push({
          bookIds: [seen.get(key)!, book.id],
          confidence: "title-author-match-review-required",
        });
      else seen.set(key, book.id);
    }
  }
  const libraries = [];
  for (const library of await client.listLibraries()) {
    let metadataOnImport: boolean | null = null;
    try {
      const config = (await client.getFetchConfig(library.id)) as {
        enabled?: boolean;
        triggerOnImport?: boolean;
      };
      metadataOnImport = Boolean(config.enabled && config.triggerOnImport);
    } catch (error) {
      if (!(error instanceof BookOrbitError) || ![403, 404].includes(error.status))
        throw error;
    }
    libraries.push({
      libraryId: library.id,
      watch: library.watch,
      renameAfterMetadata: library.fileRenameEnabled,
      metadataOnImport,
    });
  }
  let metadataQueue = null;
  try {
    const status = (await client.getFetchStatus()) as Record<string, unknown>;
    // Never include a global current-item name or raw provider failure body.
    metadataQueue = Object.fromEntries(
      ["queued", "processing", "failed", "paused"]
        .filter((k) => typeof status[k] === "number" || typeof status[k] === "boolean")
        .map((k) => [k, status[k]]),
    );
  } catch (error) {
    if (!(error instanceof BookOrbitError) || ![403, 404].includes(error.status))
      throw error;
  }
  const ids = new Set(catalog.map((b) => b.id));
  const failures = indexing.jobs
    .filter((j) => ids.has(j.book_id) && ["failed", "paused"].includes(j.state))
    .map((j) => ({ bookId: j.book_id, state: j.state, error: j.error }));
  return {
    generatedAt: new Date().toISOString(),
    scope: "current-native-account",
    summary: {
      accessibleBooks: catalog.length,
      indexedBooks: indexing.indexed,
      pendingBooks: indexing.pending.length,
      indexingExceptions: failures.length,
      missingMetadata: missing.length,
      possibleDuplicates: duplicates.length,
    },
    indexing: { pending: indexing.pending, exceptions: failures },
    annotations: indexing.annotations,
    libraries,
    metadataQueue,
    missingMetadata: missing.slice(0, 100),
    possibleDuplicates: duplicates.slice(0, 100),
    issuesTruncated: missing.length > 100 || duplicates.length > 100,
    metadataInspection:
      "Catalog fields only; filename fallbacks may hide an absent raw title",
    nextActions: [
      "Use audit_library for details and library_maintenance for current configuration",
      "Use update_book_metadata previews; preserve locks and nonempty metadata",
      "Use control_indexing for confirmed failures; do not reset the whole index",
      "Review possible duplicates; never automatically delete or merge originals",
    ],
    originalDataChanged: false,
  };
}
