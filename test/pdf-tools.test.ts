import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerExtendedTools } from "../src/extended-tools.js";
import { knowledgeWorker } from "../src/knowledge-worker.js";
import { BookOrbitError, type BookOrbitClient } from "../src/bookorbit-client.js";
import type { BookService } from "../src/book-service.js";

test("actual MCP transports image content, bounded layout pages and denial without image leakage", async () => {
  let allowed = true,
    revoke = false;
  const native = {
    async getBook() {
      if (!allowed) throw new BookOrbitError("Denied", 403, "/books/1");
      return {
        id: 1,
        libraryId: 1,
        title: "Synthetic",
        authors: [],
        files: [{ id: 2, format: "pdf" }],
      };
    },
    async downloadFile() {
      return Buffer.from("synthetic");
    },
  } as unknown as BookOrbitClient;
  const original = knowledgeWorker.request;
  knowledgeWorker.request = async (d: any): Promise<any> => {
    if (revoke) allowed = false;
    if (d.op === "pdf_images")
      return {
        pages: [
          {
            page: 24,
            data: "c3ludGhldGlj",
            mimeType: "image/jpeg",
            width: 600,
            height: 800,
          },
        ],
        totalPages: 99,
        sha256: "x",
      };
    assert.equal(d.op, "pdf_window");
    assert.equal(d.layoutAware, true);
    return {
      sections: [{ index: 23, page: 24, text: "Column-aware synthetic text" }],
      totalPages: 99,
      ocrPages: [],
      unreadablePages: [],
      layout: [{ page: 24, columns: 2, removedMarginBlocks: 2 }],
    };
  };
  const server = new McpServer({ name: "pdf-test", version: "1" });
  registerExtendedTools(server, native, {} as BookService);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "pdf-client", version: "1" });
  await server.connect(a);
  await client.connect(b);
  try {
    const image = await client.callTool({
      name: "view_pdf_pages",
      arguments: { bookId: 1, startPage: 24 },
    });
    assert.ok(!image.isError);
    assert.equal((image.content as any[])[1].type, "image");
    assert.equal(JSON.parse((image.content as any[])[0].text).page, 24);
    const text = await client.callTool({
      name: "read_pdf_pages",
      arguments: { bookId: 1, startPage: 24, layoutAware: true },
    });
    const r = JSON.parse((text.content as any[])[0].text);
    assert.equal(r.totalPages, 99);
    assert.equal(r.pages[0].page, 24);
    assert.equal(r.nextPage, 25);
    revoke = true;
    const denied = await client.callTool({
      name: "view_pdf_pages",
      arguments: { bookId: 1, startPage: 24 },
    });
    assert.equal(denied.isError, true);
    assert.ok(!(denied.content as any[]).some((c) => c.type === "image"));
  } finally {
    knowledgeWorker.request = original;
    await client.close();
    await server.close();
  }
});

test("metadata preview and apply skip native locks even with explicit overwrite", async () => {
  const writes: any[] = [];
  const native = {
    async getBook() {
      return {
        id: 1,
        title: "Locked original",
        publisher: "Old",
        lockedFields: ["title"],
        authors: [],
        files: [],
      };
    },
    async updateMetadata(_id: number, patch: any) {
      writes.push(patch);
    },
  } as unknown as BookOrbitClient;
  const server = new McpServer({ name: "lock-test", version: "1" });
  registerExtendedTools(server, native, {} as BookService);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "lock-client", version: "1" });
  await server.connect(a);
  await client.connect(b);
  try {
    const args = {
      bookId: 1,
      overwrite: true,
      patch: { title: "Must not apply", publisher: "New" },
    };
    const preview = await client.callTool({
      name: "update_book_metadata",
      arguments: args,
    });
    const p = JSON.parse((preview.content as any[])[0].text);
    assert.deepEqual(p.changes, { publisher: "New" });
    assert.deepEqual(p.skippedLocked, ["title"]);
    const applied = await client.callTool({
      name: "update_book_metadata",
      arguments: { ...args, dryRun: false, expectedState: p.expectedState },
    });
    assert.ok(!applied.isError);
    assert.deepEqual(writes, [{ publisher: "New" }]);
  } finally {
    await client.close();
    await server.close();
  }
});
