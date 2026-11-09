import { test } from "node:test";
import assert from "node:assert/strict";
import { searchOwnAnnotations } from "../src/annotation-search.js";
import { BookOrbitError, type BookOrbitClient } from "../src/bookorbit-client.js";
process.env.ANNOTATION_INDEX = "lancedb";
const book: any = {
  id: 1,
  libraryId: 1,
  title: "Synthetic",
  authors: [],
  files: [{ id: 1, format: "pdf" }],
};

test("atomic search scans past500, separates full inputs, and rechecks deletion/edit/revocation", async () => {
  const notes = Array.from({ length: 774 }, (_, i) => ({
    id: i + 1,
    bookId: 1,
    text: i === 773 ? "selected text ".repeat(500) : `Synthetic highlight ${i}`,
    note: i === 773 ? "My separate scientific observation." : null,
    deletedAt: null,
  }));
  let ranked = false,
    change = "none",
    last: any;
  const synchronized: any[] = [];
  const client = {
    async annotationCacheNamespace() {
      return "a".repeat(64);
    },
    async getBook() {
      if (ranked && change === "revoke")
        throw new BookOrbitError("Denied", 403, "/books/1");
      return book;
    },
    async listAnnotations(opts: any) {
      let current = notes;
      if (ranked && change === "delete") current = notes.slice(0, -1);
      if (ranked && change === "edit")
        current = notes.map((n) => (n.id === 774 ? { ...n, note: "edited" } : n));
      return {
        items: current.slice((opts.page - 1) * 100, opts.page * 100),
        total: current.length,
        pageSize: 100,
      };
    },
  } as unknown as BookOrbitClient;
  const worker = {
    async request(data: any): Promise<any> {
      if (data.op === "annotation_sync") {
        synchronized.push(...data.items);
        last = data.items.at(-1);
        return { indexed: data.items.length, reused: 0, errors: [] };
      }
      if (data.op === "annotation_finish") return {};
      assert.equal(data.op, "annotation_search");
      ranked = true;
      return [
        {
          id: 774,
          unitId: data.items.at(-1).id,
          kind: "note",
          version: last.version,
          score: 0.9,
          semanticSimilarity: 0.9,
        },
      ];
    },
  };
  let r = await searchOwnAnnotations(client, worker, "scientific observation", [book]);
  assert.equal(r.coverage.scanned, 774);
  assert.equal(r.coverage.truncated, false);
  assert.equal(r.coverage.atomicUnits, 775);
  assert.equal(r.annotations[0].id, 774);
  const components = synchronized.filter((u) => u.annotationId === 774);
  assert.deepEqual(
    components.map((u) => u.kind),
    ["highlight", "note"],
  );
  assert.equal(components[0].text.length, notes[773].text.length);
  assert.ok(components[0].text.length > 4000);
  for (change of ["delete", "edit", "revoke"]) {
    ranked = false;
    r = await searchOwnAnnotations(client, worker, "scientific observation", [book]);
    assert.equal(r.annotations.length, 0, change);
  }
});

test("lexical annotations need no embedding worker and retain all native pages", async () => {
  const client = {
    async annotationCacheNamespace() {
      return "b".repeat(64);
    },
    async getBook() {
      return book;
    },
    async listAnnotations() {
      return {
        items: [
          {
            id: 1,
            bookId: 1,
            text: "Atomic highlight",
            note: "quantum explanation",
            deletedAt: null,
          },
        ],
        total: 1,
      };
    },
  } as unknown as BookOrbitClient;
  const worker = {
    async request(): Promise<any> {
      throw new Error("lexical call must not invoke embedding/index worker");
    },
  };
  const r = await searchOwnAnnotations(client, worker, "quantum", [book], {
    mode: "lexical",
  });
  assert.equal(r.annotations.length, 1);
  assert.equal(r.annotations[0].matchedUnits[0].kind, "note");
  assert.equal(r.coverage.indexingRequested, false);
});

test("filtered sync cannot purge other books and repeated upstream pages fail explicitly", async () => {
  let finish: any;
  const note = { id: 1, bookId: 1, text: "synthetic", deletedAt: null };
  const client = {
    async annotationCacheNamespace() {
      return "c".repeat(64);
    },
    async getBook() {
      return book;
    },
    async listAnnotations() {
      return { items: [note], total: 1 };
    },
  } as unknown as BookOrbitClient;
  const worker = {
    async request(d: any): Promise<any> {
      if (d.op === "annotation_finish") finish = d;
      if (d.op === "annotation_sync") return { indexed: 1, reused: 0, errors: [] };
      return [];
    },
  };
  await searchOwnAnnotations(client, worker, "test", [book], { bookIds: [1] });
  assert.equal(finish.snapshotComplete, false);
  client.listAnnotations = async () => ({ items: [note], total: 700 }) as any;
  await assert.rejects(
    searchOwnAnnotations(client, worker, "test", [book]),
    /repeated a page/,
  );
});
