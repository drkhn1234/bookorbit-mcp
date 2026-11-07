import { test } from "node:test";
import assert from "node:assert/strict";
import { BookOrbitClient } from "../src/bookorbit-client.js";

for (const wrapped of [false, true]) {
  test(`shelf accepts ${wrapped ? "deployed books envelope" : "legacy array"}`, async () => {
    const books = [{ id: 1, title: "Test", authors: [] }];
    const c = new BookOrbitClient({
      baseUrl: "https://example.test",
      token: "test-token",
      fetchImpl: (async () =>
        new Response(
          JSON.stringify(wrapped ? { books, total: 100 } : books),
        )) as typeof fetch,
    });
    assert.deepEqual(await c.getBookShelf("recently-added", { limit: 2 }), books);
  });
}
