import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { BookService, sourceFingerprint } from "../src/book-service.js";
import { BookCache } from "../src/cache.js";
import { BookOrbitError, type BookOrbitClient } from "../src/bookorbit-client.js";
import { KnowledgeService } from "../src/knowledge-service.js";
import { registerExtendedTools } from "../src/extended-tools.js";
import { authenticateBearer } from "../src/http-auth.js";

const book = {
  id: 1,
  libraryId: 1,
  title: "Shared",
  authors: ["Synthetic"],
  updatedAt: "v1",
  files: [{ id: 1, format: "pdf", sizeBytes: 50 }],
};

test("bearer authentication rejects missing, forged and expired credentials", () => {
  const tokens = { good: { username: "sister", expiresAt: 200 } };
  assert.equal(authenticateBearer(undefined, tokens, 100), null);
  assert.equal(authenticateBearer("Bearer forged", tokens, 100), null);
  assert.equal(authenticateBearer("Bearer good", tokens, 201), null);
  assert.equal(authenticateBearer("Bearer good", tokens, 100)?.username, "sister");
});

test("cached EPUB sections are denied after permission revocation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bo-revoke-"));
  const cache = new BookCache(dir);
  await cache.writeParsed(
    {
      bookId: 1,
      sourceFingerprint: sourceFingerprint(book as any),
      title: "Private",
      author: "A",
      sections: [],
      totalChars: 7,
    },
    ["PRIVATE"],
  );
  let allowed = true;
  const client = {
    async getBook() {
      if (!allowed) throw new BookOrbitError("Not found", 404, "/books/1");
      return book;
    },
  } as unknown as BookOrbitClient;
  const service = new BookService(client, cache);
  assert.equal(await service.getSectionText(1, 0), "PRIVATE");
  allowed = false;
  await assert.rejects(service.getSectionText(1, 0), /Not found/);
  await assert.rejects(service.getParsedBook(1), /Not found/);
});

test("retrieval prefilters user catalog and rechecks permission after vector results", async () => {
  let revoked = false;
  const client = {
    async queryBooks() {
      return { items: [book], total: 1 };
    },
    async getBook() {
      if (revoked) throw new BookOrbitError("Not found", 404, "/books/1");
      return book;
    },
  } as unknown as BookOrbitClient;
  const worker = {
    async request(data: any): Promise<any> {
      if (data.op === "jobs") return [];
      if (data.op === "status")
        return { model: "test", revision: "1", indexIdentity: "x", sources: [] };
      assert.deepEqual(data.allowed, [
        { bookId: 1, fingerprint: sourceFingerprint(book as any) },
      ]);
      revoked = true;
      return [
        { book_id: 1, fingerprint: sourceFingerprint(book as any), text: "PRIVATE" },
      ];
    },
  };
  const knowledge = new KnowledgeService(client, {} as BookService, tmpdir(), worker);
  assert.equal((await knowledge.search("secret")).passages.length, 0);
});

test("PDF cache never bypasses revocation", async () => {
  let allowed = true;
  let extractions = 0;
  const client = {
    async getBook() {
      if (!allowed) throw new BookOrbitError("Not found", 404, "/books/1");
      return book;
    },
    async downloadFile() {
      return Buffer.from("pdf");
    },
  } as unknown as BookOrbitClient;
  const worker = {
    async request(): Promise<any> {
      extractions++;
      return {
        sections: [{ index: 0, label: "Page 1", page: 1, text: "PRIVATE" }],
        ocrPages: [],
        unreadablePages: [],
        sha256: "test",
      };
    },
  };
  const knowledge = new KnowledgeService(
    client,
    {} as BookService,
    await mkdtemp(join(tmpdir(), "bo-pdf-")),
    worker,
  );
  assert.equal((await knowledge.pdf(1)).document.sections[0].text, "PRIVATE");
  await knowledge.pdf(1);
  assert.equal(extractions, 1);
  allowed = false;
  await assert.rejects(knowledge.pdf(1), /Not found/);
});

test("actual MCP initializes, discovers extensions and previews/applies native automation", async () => {
  const writes: unknown[] = [];
  let watch = false;
  const native = {
    async getLibrary() {
      return { id: 1, watch, fileRenameEnabled: false };
    },
    async getFetchConfig() {
      return { enabled: false, triggerOnImport: false };
    },
    async getFetchStatus() {
      return { queued: 0 };
    },
    async updateLibrary(_id: number, patch: any) {
      writes.push(patch);
      watch = patch.watch;
    },
    async updateFetchConfig(_id: number, patch: any) {
      writes.push(patch);
    },
  } as unknown as BookOrbitClient;
  const server = new McpServer({ name: "test", version: "1" });
  registerExtendedTools(server, native, {} as BookService);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "independent-sdk-client", version: "1" });
  await server.connect(a);
  await client.connect(b);
  try {
    const tools = await client.listTools();
    assert.equal(tools.tools.length, 15);
    const invoke = async (args: any) =>
      client.callTool({ name: "library_maintenance", arguments: args });
    const preview = await invoke({
      libraryId: 1,
      action: "configure",
      watch: true,
      metadataOnImport: true,
    });
    const content = JSON.parse((preview.content as any)[0].text);
    assert.equal(writes.length, 0);
    assert.equal(
      (
        await invoke({
          libraryId: 1,
          action: "configure",
          watch: true,
          dryRun: false,
          expectedState: "0".repeat(64),
        })
      ).isError,
      true,
    );
    assert.equal(writes.length, 0);
    assert.equal(
      (
        await invoke({
          libraryId: 1,
          action: "configure",
          watch: true,
          metadataOnImport: true,
          dryRun: false,
          expectedState: content.expectedState,
        })
      ).isError,
      undefined,
    );
    assert.equal(writes.length, 2);
    assert.equal(
      (
        await invoke({
          libraryId: 1,
          action: "configure",
          watch: true,
          dryRun: false,
          expectedState: content.expectedState,
        })
      ).isError,
      true,
    );
  } finally {
    await client.close();
    await server.close();
  }
});

test("deployed detail entity authors normalize to catalog names for indexing fingerprints", async () => {
  const { BookOrbitClient } = await import("../src/bookorbit-client.js");
  const native = new BookOrbitClient({
    baseUrl: "http://unit.test",
    token: "test",
    fetchImpl: async () =>
      new Response(
        JSON.stringify({
          ...book,
          authors: [{ id: 2, name: "Synthetic", sortName: "S" }],
          genres: [{ id: 3, name: "Science" }],
          tags: [],
        }),
      ),
  });
  const detail = await native.getBook(1);
  assert.deepEqual(detail.authors, ["Synthetic"]);
  assert.deepEqual(detail.genres, ["Science"]);
  assert.equal(sourceFingerprint(detail), sourceFingerprint(book as any));
});

test("native provider metadata stream is decoded without applying metadata", async () => {
  const { BookOrbitClient } = await import("../src/bookorbit-client.js");
  const paths: string[] = [];
  const native = new BookOrbitClient({
    baseUrl: "http://unit.test",
    token: "test",
    fetchImpl: async (url, init) => {
      paths.push(String(url));
      assert.equal(init?.method, undefined);
      return new Response(
        'data: {"provider":"test","title":"Synthetic"}\n\ndata: {"done":true}\n\n',
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  });
  const events = await native.searchBookMetadata("Synthetic");
  assert.equal(events.length, 2);
  assert.ok(paths[0].includes("/metadata-fetch/stream?title=Synthetic"));
});

test("book metadata ranking favors physics over programming without excluding other books", async () => {
  const { metadataScore } = await import("../src/retrieval-ranking.js");
  const query = "electromagnetism and magnetic fields";
  assert.ok(
    metadataScore(query, { title: "Introduction to Electrodynamics" }) >
      metadataScore(query, { title: "Programming class fields" }),
  );
});

test("bounded pending-book inspection rechecks permission after extracting text", async () => {
  let allowed = true;
  const native = {
    async getBook() {
      if (!allowed) throw new BookOrbitError("Not found", 404, "/books/1");
      return book;
    },
    async downloadFile() {
      return Buffer.from("pdf");
    },
  } as unknown as BookOrbitClient;
  const worker = {
    async request(): Promise<any> {
      allowed = false;
      return {
        sections: [{ index: 0, page: 1, label: "Page 1", text: "PRIVATE" }],
        totalPages: 20,
      };
    },
  };
  const service = new KnowledgeService(native, {} as BookService, tmpdir(), worker);
  await assert.rejects(service.inspect(1, 1, 2), /Not found/);
});

test("explicit index dispatch never chooses an unrelated pending book and respects pause", async () => {
  const originalStatus = KnowledgeService.prototype.status;
  const originalIndex = KnowledgeService.prototype.indexBook;
  const selected: number[] = [];
  let paused = false;
  const native = {
    async queryBooks() {
      return {
        items: [
          { ...book, id: 1 },
          { ...book, id: 306 },
        ],
        total: 2,
      };
    },
  } as unknown as BookOrbitClient;
  try {
    KnowledgeService.prototype.status = async () => ({
      model: "test",
      revision: "1",
      indexIdentity: "test",
      building: [],
      accessibleBooks: 2,
      supportedBooks: 2,
      indexed: 0,
      pending: [1, 306],
      unsupported: 0,
      jobs: paused ? [{ book_id: 306, state: "paused", priority: 100 }] : [],
    });
    KnowledgeService.prototype.indexBook = async function (id: number) {
      selected.push(id);
      return { bookId: id };
    };
    const service = new KnowledgeService(native, {} as BookService, tmpdir());
    await service.indexPending(1, [306]);
    assert.deepEqual(selected, [306]);
    paused = true;
    await service.indexPending(1, [306]);
    assert.deepEqual(selected, [306]);
  } finally {
    KnowledgeService.prototype.status = originalStatus;
    KnowledgeService.prototype.indexBook = originalIndex;
  }
});

test("versioned passage context rejects stale sources and post-worker revocation", async () => {
  let revoked = false;
  const fp = sourceFingerprint(book as any);
  const native = {
    async getBook() {
      if (revoked) throw new BookOrbitError("Not found", 404, "/books/1");
      return book;
    },
  } as unknown as BookOrbitClient;
  let calls = 0;
  const worker = {
    async request(data: any): Promise<any> {
      calls++;
      assert.equal(data.fingerprint, fp);
      revoked = true;
      return {
        passage: { id: "c".repeat(64), book_id: 1, fingerprint: fp, text: "private" },
        context: [],
      };
    },
  };
  const service = new KnowledgeService(native, {} as BookService, tmpdir(), worker);
  await assert.rejects(
    service.passage(1, "c".repeat(64), "0".repeat(64)),
    /version changed/,
  );
  assert.equal(calls, 0);
  await assert.rejects(service.passage(1, "c".repeat(64), fp), /Not found/);
});

test("semantic notes omit deleted, edited and revoked results even after ranking", async () => {
  const initial = {
    id: 5,
    bookId: 1,
    text: "Neurons communicate via synapses.",
    note: null,
    deletedAt: null,
  };
  let live: any[] = [initial];
  let revoke = false;
  let ranked = false;
  const native = {
    async annotationCacheNamespace() {
      return "a".repeat(64);
    },
    async queryBooks() {
      ranked = false;
      return { items: [book], total: 1 };
    },
    async getBook() {
      if (revoke) throw new BookOrbitError("Not found", 404, "/books/1");
      return book;
    },
    async listAnnotations(_opts: any) {
      return { items: ranked ? live : [initial], total: 1, pageSize: 100 };
    },
  } as unknown as BookOrbitClient;
  let change: () => void = () => {};
  let namespace: string | undefined;
  const worker = {
    async request(data: any): Promise<any> {
      assert.equal(data.op, "search_notes");
      namespace = data.namespace;
      ranked = true;
      assert.equal(data.items.length, 1);
      change();
      return [{ ...data.items[0], score: 0.9, semanticSimilarity: 0.9 }];
    },
  };
  const service = new KnowledgeService(native, {} as BookService, tmpdir(), worker);
  assert.equal((await service.searchAnnotations("nerve signals")).annotations.length, 1);
  change = () => {
    live = [];
  };
  assert.equal((await service.searchAnnotations("nerve signals")).annotations.length, 0);
  change = () => {
    live = [{ ...initial, text: "edited" }];
  };
  assert.equal((await service.searchAnnotations("nerve signals")).annotations.length, 0);
  change = () => {
    revoke = true;
  };
  assert.equal((await service.searchAnnotations("nerve signals")).annotations.length, 0);
  const firstNamespace = namespace;
  revoke = false;
  change = () => {};
  live = [initial];
  const other = {
    ...native,
    async annotationCacheNamespace() {
      return "b".repeat(64);
    },
  } as BookOrbitClient;
  await new KnowledgeService(
    other,
    {} as BookService,
    tmpdir(),
    worker,
  ).searchAnnotations("nerve signals");
  assert.notEqual(namespace, firstNamespace);
});

test("annotation search excludes inaccessible snapshot notes and reports bounded coverage", async () => {
  const native = {
    async annotationCacheNamespace() {
      return "a".repeat(64);
    },
    async queryBooks() {
      return { items: [], total: 0 };
    },
    async listAnnotations() {
      return {
        items: [{ id: 9, bookId: 99, text: "PRIVATE" }],
        total: 600,
        pageSize: 100,
      };
    },
  } as unknown as BookOrbitClient;
  const worker = {
    async request(data: any): Promise<any> {
      assert.deepEqual(data.items, []);
      return [];
    },
  };
  const result = await new KnowledgeService(
    native,
    {} as BookService,
    tmpdir(),
    worker,
  ).searchAnnotations("anything");
  assert.equal(result.annotations.length, 0);
  assert.equal(result.coverage.truncated, true);
});

test("PDF limit allows bounded larger textbooks and rejects unsafe configuration", async () => {
  const { pdfMaxBytes } = await import("../src/pdf-limits.js");
  const before = process.env.PDF_MAX_MIB;
  try {
    delete process.env.PDF_MAX_MIB;
    assert.equal(pdfMaxBytes(), 80 * 1024 * 1024);
    process.env.PDF_MAX_MIB = "128";
    assert.equal(pdfMaxBytes(), 128 * 1024 * 1024);
    for (const value of ["0", "129", "NaN", "1.5"]) {
      process.env.PDF_MAX_MIB = value;
      assert.throws(pdfMaxBytes, /PDF_MAX_MIB/);
    }
  } finally {
    if (before === undefined) delete process.env.PDF_MAX_MIB;
    else process.env.PDF_MAX_MIB = before;
  }
});
