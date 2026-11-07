import { createHash } from "node:crypto";
import type { BookDetail } from "./types.js";
import type { BookOrbitClient } from "./bookorbit-client.js";
import type { BookCache } from "./cache.js";
import { resolveSections } from "./epub-structure.js";
import { htmlToText } from "./html-to-text.js";
import type { ParsedBook, SectionWithSize } from "./types.js";

export interface SearchHit {
  sectionIndex: number;
  label: string;
  snippet: string;
  charOffset: number;
  approxBookPercent: number;
}

const SNIPPET_CONTEXT = 140;
const MAX_HITS_PER_SECTION = 5;

/** Orchestrates the client, EPUB structure resolution, extraction, and cache. */
export class BookService {
  private inflight = new Map<number, Promise<ParsedBook>>();

  constructor(
    private readonly client: BookOrbitClient,
    private readonly cache: BookCache,
  ) {}

  /** Get a parsed+measured book, building and caching it on first access. */
  async getParsedBook(bookId: number): Promise<ParsedBook> {
    const book = await this.client.getBook(bookId);
    const fingerprint = sourceFingerprint(book);
    const cached = await this.cache.readParsed(bookId);
    if (cached?.sourceFingerprint === fingerprint) return cached;

    // De-duplicate concurrent builds of the same book.
    const existing = this.inflight.get(bookId);
    if (existing) return existing;

    const build = this.buildParsedBook(bookId, fingerprint).finally(() =>
      this.inflight.delete(bookId),
    );
    this.inflight.set(bookId, build);
    return build;
  }

  /** Extracted text of one section (rebuilds the book if the cache is cold). */
  async getSectionText(bookId: number, index: number): Promise<string> {
    await this.getParsedBook(bookId);
    const text = await this.cache.readSectionText(bookId, index);
    return text ?? "";
  }

  /** Authorized bulk extraction avoids one HTTP lookup per section. */
  async getTextSections(bookId: number) {
    const parsed = await this.getParsedBook(bookId);
    const sections = [];
    for (const section of parsed.sections) {
      sections.push({
        index: section.index,
        label: section.label,
        text: (await this.cache.readSectionText(bookId, section.index)) ?? "",
      });
    }
    if (sourceFingerprint(await this.client.getBook(bookId)) !== parsed.sourceFingerprint)
      throw new Error("Book changed during extraction; retry");
    return sections;
  }

  /** Case-insensitive keyword search across one book's cached section text. */
  async searchInBook(
    bookId: number,
    query: string,
    maxResults = 20,
    caseSensitive = false,
  ): Promise<SearchHit[]> {
    const parsed = await this.getParsedBook(bookId);
    const needle = caseSensitive ? query : query.toLowerCase();
    const hits: SearchHit[] = [];
    let charsBefore = 0;

    for (const section of parsed.sections) {
      if (hits.length >= maxResults) break;
      const text = await this.getSectionText(bookId, section.index);
      const haystack = caseSensitive ? text : text.toLowerCase();

      let from = 0;
      let inSection = 0;
      while (inSection < MAX_HITS_PER_SECTION && hits.length < maxResults) {
        const at = haystack.indexOf(needle, from);
        if (at === -1) break;
        hits.push({
          sectionIndex: section.index,
          label: section.label,
          snippet: makeSnippet(text, at, query.length),
          charOffset: at,
          approxBookPercent: percent(charsBefore + at, parsed.totalChars),
        });
        from = at + Math.max(needle.length, 1);
        inSection++;
      }
      charsBefore += section.charCount;
    }
    return hits;
  }

  // --- build ---------------------------------------------------------------

  private async buildParsedBook(
    bookId: number,
    fingerprint: string,
  ): Promise<ParsedBook> {
    const info = await this.client.getEpubInfo(bookId);
    const sections = resolveSections(info);

    // Fetch each referenced spine file exactly once.
    const uniqueHrefs = [...new Set(sections.map((s) => s.spineHref))];
    const files = new Map<string, string>();
    await Promise.all(
      uniqueHrefs.map(async (href) => {
        files.set(href, await this.client.getEpubFile(bookId, href));
      }),
    );

    const sectionTexts: string[] = [];
    const measured: SectionWithSize[] = [];
    let totalChars = 0;
    for (const section of sections) {
      const html = files.get(section.spineHref) ?? "";
      const text = htmlToText(html, section.startAnchor, section.endAnchor);
      sectionTexts.push(text);
      const charCount = text.length;
      totalChars += charCount;
      measured.push({
        ...section,
        charCount,
        wordCount: countWords(text),
      });
    }

    const parsed: ParsedBook = {
      bookId,
      sourceFingerprint: fingerprint,
      title: info.metadata.title ?? "Unknown title",
      author: info.metadata.creator ?? "Unknown author",
      sections: measured,
      totalChars,
    };
    await this.cache.writeParsed(parsed, sectionTexts);
    return parsed;
  }
}

function countWords(text: string): number {
  const trimmed = text.trim();
  return trimmed ? trimmed.split(/\s+/).length : 0;
}

function percent(pos: number, total: number): number {
  if (total <= 0) return 0;
  return Math.round((pos / total) * 1000) / 10;
}

function makeSnippet(text: string, at: number, matchLen: number): string {
  const start = Math.max(0, at - SNIPPET_CONTEXT);
  const end = Math.min(text.length, at + matchLen + SNIPPET_CONTEXT);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < text.length ? "…" : "";
  return `${prefix}${text.slice(start, end).replace(/\s+/g, " ").trim()}${suffix}`;
}

/** Includes library moves and file changes; upstream updatedAt is authoritative. */
export function sourceFingerprint(book: BookDetail): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        book.id,
        book.libraryId,
        book.updatedAt,
        book.title,
        book.authors,
        book.files
          ?.map((f) => [f.id, f.format, f.sizeBytes])
          .sort((a, b) => Number(a[0]) - Number(b[0])),
      ]),
    )
    .digest("hex");
}
