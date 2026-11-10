import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { BookOrbitClient } from "../src/bookorbit-client.js";
import { registerOrganizationTools, validateScopeFilter } from "../src/organization.js";

const rule = (field = "format", operator = "includesAny", value: unknown = ["pdf"]) => ({
  type: "rule",
  field,
  operator,
  value,
});
const group = (...rules: any[]) => ({ type: "group", join: "AND", rules });
const filter = group(rule());

test("scope validation rejects unsupported, malformed and unbounded rules", () => {
  assert.deepEqual(
    validateScopeFilter(
      group(filter, { type: "rule", field: "readProgress", operator: "isUnread" }),
    ),
    group(filter, { type: "rule", field: "readProgress", operator: "isUnread" }),
  );
  for (const input of [
    group(rule("sql", "eq", "anything")),
    group(rule("title", "includesAny", ["x"])),
    group(rule("format", "includesAny", [1])),
    group(rule("rating", "gte", "high")),
    group(rule("title", "contains", "")),
    group(rule("addedAt", "after", "2026-02-30")),
    group(rule("addedAt", "withinLast", -1)),
    group(rule("isbn", "isEmpty", "unused")),
    group({ ...rule("publishedYear", "between", 2026), valueTo: 2000 }),
    group({ ...rule(), extraSql: "no" }),
    group(),
    group(...Array(101).fill(rule())),
    group(group(group(group(group(group(rule())))))),
    group(rule("title", "contains", "x".repeat(33000))),
  ])
    assert.throws(() => validateScopeFilter(input));
});

// Real MCP transport and native HTTP client. The mock API is deliberately stateful
// and enforces owner/book permissions, including revocation between calls.
async function setup() {
  let owner = "A",
    allowBook = true,
    nextId = 10;
  const shelves = new Map<string, any>();
  const writes: any[] = [];
  const json = (data: unknown, status = 200) =>
    new Response(JSON.stringify(data), { status });
  const native = new BookOrbitClient({
    baseUrl: "https://example.invalid",
    token: "test-only",
    fetchImpl: (async (input: any, init: RequestInit = {}) => {
      const url = new URL(String(input)),
        path = url.pathname.replace("/api/v1", "");
      const method = init.method ?? "GET",
        body = init.body ? JSON.parse(String(init.body)) : {};
      if (path === "/auth/me") return json({ id: owner });
      if (path === "/books/query")
        return json({
          total: 1,
          items: [
            {
              id: 1,
              title: "PDF",
              authors: [],
              files: [{ absolutePath: "/private/server/path" }],
            },
          ],
        });
      if (path.startsWith("/books/"))
        return allowBook
          ? json({ id: 1, title: "PDF", libraryId: 1, files: [] })
          : json({ message: "Book denied" }, 403);
      const [, kind, rawId, books] = path.split("/");
      if (kind !== "collections" && kind !== "smart-scopes") return json({}, 404);
      const key = `${kind}/${rawId}`,
        shelf = shelves.get(key);
      if (method === "GET") {
        if (!rawId)
          return json(
            [...shelves.values()].filter(
              (s) => s.kind === kind && (s.owner === owner || s.isPublic),
            ),
          );
        return shelf && (shelf.owner === owner || shelf.isPublic)
          ? json(shelf)
          : json({ message: "Shelf denied" }, 403);
      }
      if (method === "POST" && !rawId) {
        const created = { ...body, id: nextId++, owner, kind, bookCount: 0, members: [] };
        shelves.set(`${kind}/${created.id}`, created);
        writes.push({ method, path, body });
        return json(created);
      }
      if (!shelf || shelf.owner !== owner) return json({ message: "Not owner" }, 403);
      if (books && !allowBook) return json({ message: "Book denied" }, 403);
      writes.push({ method, path, body });
      if (books) {
        shelf.members =
          method === "POST"
            ? [...new Set([...shelf.members, ...body.bookIds])]
            : shelf.members.filter((n: number) => !body.bookIds.includes(n));
        shelf.bookCount = shelf.members.length;
      } else if (method === "PATCH") Object.assign(shelf, body);
      else if (method === "DELETE") {
        shelves.delete(key);
        return new Response(null, { status: 204 });
      }
      return json(shelf);
    }) as typeof fetch,
  });
  const server = new McpServer({ name: "organization-test", version: "1" });
  registerOrganizationTools(server, native);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "1" });
  await server.connect(a);
  await client.connect(b);
  const raw = (name: string, args: any) => client.callTool({ name, arguments: args });
  const call = async (name: string, args: any) => {
    const r = await raw(name, args);
    assert.ok(!r.isError, JSON.stringify(r));
    return JSON.parse((r.content as any[])[0].text);
  };
  const apply = async (name: string, args: any) => {
    const p = await call(name, args);
    return call(name, { ...args, dryRun: false, expectedState: p.expectedState });
  };
  return {
    client,
    call,
    raw,
    apply,
    writes,
    shelves,
    setOwner: (v: string) => {
      owner = v;
    },
    revokeBook: () => {
      allowBook = false;
    },
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

test("MCP discovers explicit schemas/options and scope preview is read-only and path-free", async () => {
  const h = await setup();
  try {
    const tools = (await h.client.listTools()).tools;
    assert.deepEqual(tools.map((t) => t.name).sort(), [
      "manage_collection",
      "manage_smart_scope",
      "organization_options",
    ]);
    const options = await h.call("organization_options", {});
    assert.ok(options.fields.tag);
    const p = await h.call("manage_smart_scope", {
      action: "create",
      patch: { name: "PDFs", filter },
    });
    assert.equal(h.writes.length, 0);
    assert.equal(p.matches.total, 1);
    assert.equal(p.changes.isPublic, false);
    assert.ok(!JSON.stringify(p).includes("/private/server/path"));
    const made = await h.call("manage_smart_scope", {
      action: "create",
      patch: { name: "PDFs", filter },
      dryRun: false,
      expectedState: p.expectedState,
    });
    assert.equal(made.smartScope.filter.rules[0].value[0], "pdf");
    assert.equal(h.writes[0].path, "/smart-scopes");
    const got = await h.call("manage_smart_scope", {
      action: "get",
      scopeId: made.smartScope.id,
    });
    assert.equal(got.smartScope.name, "PDFs");
  } finally {
    await h.close();
  }
});

test("collection create, membership and delete use native endpoints, never book/file deletion", async () => {
  const h = await setup();
  try {
    const made = await h.apply("manage_collection", {
      action: "create",
      patch: { name: "Study", description: "Related concepts" },
    });
    const id = made.collection.id;
    assert.equal(made.collection.isPublic, false);
    await h.apply("manage_collection", {
      action: "add_books",
      collectionId: id,
      bookIds: [1, 1],
    });
    assert.deepEqual(h.writes.at(-1).body, { bookIds: [1] });
    await h.apply("manage_collection", {
      action: "remove_books",
      collectionId: id,
      bookIds: [1],
    });
    assert.equal(h.writes.at(-1).method, "DELETE");
    assert.equal(h.writes.at(-1).path, `/collections/${id}/books`);
    await h.apply("manage_collection", {
      action: "update",
      collectionId: id,
      patch: { name: "Renamed" },
    });
    const deleted = await h.apply("manage_collection", {
      action: "delete",
      collectionId: id,
    });
    assert.equal(deleted.booksDeleted, false);
    assert.ok(h.writes.every((w) => !w.path.startsWith("/books")));
  } finally {
    await h.close();
  }
});

test("preview binds intent/account and rejects missing, altered and stale writes", async () => {
  const h = await setup();
  try {
    const args = { action: "create", patch: { name: "Original" } };
    const p = await h.call("manage_collection", args);
    assert.equal(
      (await h.raw("manage_collection", { ...args, dryRun: false })).isError,
      true,
    );
    assert.equal(
      (
        await h.raw("manage_collection", {
          ...args,
          patch: { name: "Changed" },
          dryRun: false,
          expectedState: p.expectedState,
        })
      ).isError,
      true,
    );
    h.setOwner("B");
    assert.equal(
      (
        await h.raw("manage_collection", {
          ...args,
          dryRun: false,
          expectedState: p.expectedState,
        })
      ).isError,
      true,
    );
    h.setOwner("A");
    const made = await h.apply("manage_collection", args);
    const update = {
      action: "update",
      collectionId: made.collection.id,
      patch: { name: "New" },
    };
    const old = await h.call("manage_collection", update);
    h.shelves.get(`collections/${made.collection.id}`).description = "Concurrent edit";
    const count = h.writes.length;
    assert.equal(
      (
        await h.raw("manage_collection", {
          ...update,
          dryRun: false,
          expectedState: old.expectedState,
        })
      ).isError,
      true,
    );
    assert.equal(h.writes.length, count);
    assert.equal((await h.raw("manage_collection", args)).isError, true); // duplicate retry
  } finally {
    await h.close();
  }
});

test("revocation prevents membership apply and public shelves remain native-owner protected", async () => {
  const h = await setup();
  try {
    const made = await h.apply("manage_collection", {
      action: "create",
      patch: { name: "Shared", isPublic: true },
    });
    const id = made.collection.id;
    const args = { action: "add_books", collectionId: id, bookIds: [1] };
    const p = await h.call("manage_collection", args);
    h.revokeBook();
    const count = h.writes.length;
    assert.equal(
      (
        await h.raw("manage_collection", {
          ...args,
          dryRun: false,
          expectedState: p.expectedState,
        })
      ).isError,
      true,
    );
    assert.equal(h.writes.length, count);
    h.setOwner("B");
    const del = { action: "delete", collectionId: id };
    const publicPreview = await h.call("manage_collection", del);
    assert.equal(
      (
        await h.raw("manage_collection", {
          ...del,
          dryRun: false,
          expectedState: publicPreview.expectedState,
        })
      ).isError,
      true,
    );
    assert.ok(h.shelves.has(`collections/${id}`));
  } finally {
    await h.close();
  }
});

test("scope update validates nested rules and rejects stale deletion preview", async () => {
  const h = await setup();
  try {
    const made = await h.apply("manage_smart_scope", {
      action: "create",
      patch: { name: "PDFs", filter },
    });
    const id = made.smartScope.id;
    const nested = group({
      type: "group",
      join: "OR",
      rules: [rule(), rule("format", "includesAny", ["epub"])],
    });
    await h.apply("manage_smart_scope", {
      action: "update",
      scopeId: id,
      patch: { filter: nested, defaultSort: [{ field: "title", dir: "asc" }] },
    });
    const del = { action: "delete", scopeId: id },
      p = await h.call("manage_smart_scope", del);
    h.shelves.get(`smart-scopes/${id}`).name = "Concurrent scope edit";
    assert.equal(
      (
        await h.raw("manage_smart_scope", {
          ...del,
          dryRun: false,
          expectedState: p.expectedState,
        })
      ).isError,
      true,
    );
    const d = await h.apply("manage_smart_scope", del);
    assert.equal(d.booksDeleted, false);
    assert.ok(!h.shelves.has(`smart-scopes/${id}`));
  } finally {
    await h.close();
  }
});

test("inconsistent arguments and unsupported filter fields cannot cause writes", async () => {
  const h = await setup();
  try {
    for (const [name, args] of [
      ["manage_collection", { action: "create", patch: { name: "X" }, bookIds: [1] }],
      ["manage_collection", { action: "update", collectionId: 1 }],
      ["manage_collection", { action: "delete", collectionId: 1, patch: { name: "X" } }],
      ["manage_smart_scope", { action: "create", patch: { name: "X" } }],
      [
        "manage_smart_scope",
        {
          action: "create",
          patch: { name: "X", filter: group(rule("privateUser", "eq", "other")) },
        },
      ],
    ] as [string, any][])
      assert.equal((await h.raw(name, args)).isError, true);
    assert.equal(h.writes.length, 0);
  } finally {
    await h.close();
  }
});
