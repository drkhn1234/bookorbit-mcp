import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { passageCitation } from "../src/citations.js";
import { metadataScore } from "../src/retrieval-ranking.js";
import { KnowledgeService } from "../src/knowledge-service.js";
import { BookOrbitError, type BookOrbitClient } from "../src/bookorbit-client.js";
import type { BookService } from "../src/book-service.js";

const book: any = {
  id: 1,
  libraryId: 1,
  title: "Synthetic",
  authors: [],
  files: [
    { id: 10, format: "epub" },
    { id: 20, format: "pdf" },
  ],
};

test("PDF citations navigate to the PDF file and physical page, never the EPUB", () => {
  const previous = process.env.PUBLIC_URL;
  process.env.PUBLIC_URL = "https://books.example.com/";
  try {
    const row: any = { id: "p", fingerprint: "f", page: 24, section: 23 };
    const pdf = passageCitation(book, row);
    assert.equal(pdf.readerUrl, "https://books.example.com/read/1/20?page=24");
    assert.deepEqual(pdf.inspection, {
      tool: "read_pdf_pages",
      arguments: {
        bookId: 1,
        startPage: 24,
        pageCount: 1,
      },
    });
    const epub = passageCitation(book, { ...row, page: 0, section: 4 });
    assert.equal(epub.readerUrl, null);
    assert.equal(epub.inspection.tool, "inspect_book");
    assert.deepEqual(epub.inspection.arguments, { bookId: 1, start: 5, count: 1 });
  } finally {
    if (previous === undefined) delete process.env.PUBLIC_URL;
    else process.env.PUBLIC_URL = previous;
  }
});

test("metadata hints match words rather than accidental substrings", () => {
  assert.equal(metadataScore("art", { title: "Particle physics" }), 0);
  assert.equal(metadataScore("art", { title: "History of Art" }), 2);
  assert.equal(metadataScore("electromagnetism", { title: "Electromagnetic waves" }), 2);
});

test("native EPUB HTTP 500 can use PDF; permission errors never trigger fallback", async () => {
  const native = {
    async getBook() {
      return book;
    },
  } as unknown as BookOrbitClient;
  let failure = new BookOrbitError("Native parser failed", 500, "/epub/1/info");
  const books = {
    async getTextSections() {
      throw failure;
    },
  } as unknown as BookService;
  let pdfReads = 0;
  let indexed: any;
  const worker = {
    async request(data: any): Promise<any> {
      if (data.op === "status") return { sources: [] };
      if (data.op === "index") {
        indexed = data;
        return { passages: 1 };
      }
      return {};
    },
  };
  const service = new KnowledgeService(native, books, tmpdir(), worker);
  service.pdf = async () => {
    pdfReads++;
    return {
      book,
      document: {
        sections: [{ index: 23, page: 24, label: "Page 24", text: "Synthetic PDF" }],
        ocrPages: [],
        unreadablePages: [],
        sha256: "x",
      },
    };
  };
  const result: any = await service.indexBook(1);
  assert.equal(pdfReads, 1);
  assert.equal(indexed.sections[0].page, 24);
  assert.match(result.warnings[0], /PDF copy/);
  for (const status of [401, 403, 404, 429]) {
    failure = new BookOrbitError("Denied", status, "/epub/1/info");
    await assert.rejects(service.indexBook(1), /Denied/);
  }
  failure = new BookOrbitError("Other native failure", 500, "/auth/me");
  await assert.rejects(service.indexBook(1), /Other native failure/);
  assert.equal(pdfReads, 1);
});

test("browse filename fallback cannot starve indexing or hide an indexed missing-title book", async () => {
  const { sourceFingerprint } = await import("../src/book-service.js");
  const detail: any = { ...book, id: 904, title: null };
  const browse = { ...detail, title: "filename-fallback" };
  const fingerprint = sourceFingerprint(detail);
  const native = {
    async queryBooks() {
      return { items: [{ ...browse }], total: 1 };
    },
    async getBook() {
      return detail;
    },
  } as unknown as BookOrbitClient;
  const worker = {
    async request(data: any): Promise<any> {
      if (data.op === "jobs") return [];
      if (data.op === "status")
        return { sources: [{ bookId: detail.id, fingerprint, passages: 1 }] };
      if (data.op === "search") {
        assert.deepEqual(data.allowed, [{ bookId: detail.id, fingerprint }]);
        return [
          {
            id: "p",
            book_id: detail.id,
            fingerprint,
            section: 0,
            page: 1,
            text: "Synthetic indexed passage",
            score: 1,
            semanticSimilarity: 0.8,
          },
        ];
      }
      throw new Error("Unexpected worker operation");
    },
  };
  const service = new KnowledgeService(native, {} as BookService, tmpdir(), worker);
  const status = await service.status();
  assert.equal(status.indexed, 1);
  assert.deepEqual(status.pending, []);
  const result = await service.search("synthetic");
  assert.equal(result.passages.length, 1);
  assert.equal(result.passages[0].citation.title, "Untitled");
  assert.equal(result.passages[0].citation.sourceVersion, fingerprint);
});
