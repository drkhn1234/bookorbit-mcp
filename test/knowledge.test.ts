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
    assert.equal(tools.tools.length, 9);
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
