import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { BookOrbitClient } from "../src/bookorbit-client.js";
import { registerTools } from "../src/tools.js";
import type { BookService } from "../src/book-service.js";

test("catalog MCP pages 1/2 map to native 0/1 without skipping first collection/scope books", async () => {
  const requests: URL[] = [];
  const native = new BookOrbitClient({
    baseUrl: "https://example.invalid",
    token: "test-only",
    fetchImpl: (async (input: any) => {
      const url = new URL(String(input));
      requests.push(url);
      const page = Number(url.searchParams.get("page") ?? "0");
      const items = [
        { id: 11, title: "First", name: "First", authors: [], files: [] },
        { id: 12, title: "Second", name: "Second", authors: [], files: [] },
      ].slice(page, page + 1);
      return new Response(JSON.stringify({ items, total: 2, page, size: 1 }), {
        status: 200,
      });
    }) as typeof fetch,
  });
  const server = new McpServer({ name: "pagination-regression", version: "1" });
  registerTools(server, native, {} as BookService);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "native-pagination-client", version: "1" });
  await server.connect(a);
  await client.connect(b);
  try {
    for (const [name, args, key, idKey] of [
      ["get_collection_books", { collectionId: 1 }, "books", "bookId"],
      ["get_smart_scope_books", { scopeId: 1 }, "books", "bookId"],
      ["get_series_books", { seriesId: 1 }, "books", "bookId"],
      ["get_author_books", { authorId: 1 }, "books", "bookId"],
      ["list_series", {}, "series", "seriesId"],
      ["list_authors", {}, "authors", "authorId"],
    ] as const) {
      for (const page of [undefined, 1, 2]) {
        const r = await client.callTool({
          name,
          arguments: { ...args, size: 1, ...(page ? { page } : {}) },
        });
        assert.ok(!r.isError);
        const data = JSON.parse((r.content as any[])[0].text);
        assert.equal(data.page, page ?? 1);
        assert.equal(data[key][0][idKey], page === 2 ? 12 : 11);
        assert.equal(requests.at(-1)?.searchParams.get("page"), page === 2 ? "1" : "0");
      }
    }
  } finally {
    await client.close();
    await server.close();
  }
});
