import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, chmod, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ProcurementService } from "../src/procurement.js";
import type { BookOrbitClient } from "../src/bookorbit-client.js";

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "procurement-test-"));
  const config = join(dir, "config.json");
  await writeFile(
    config,
    JSON.stringify({
      baseUrl: "http://127.0.0.1:5056",
      accounts: {
        A: { token: "synthetic-A", userId: 1 },
        B: { token: "synthetic-B", userId: 2 },
      },
    }),
    { mode: 0o600 },
  );
  let allow = true,
    owner = "A",
    uploads = 0,
    failUpload = false,
    completed = false;
  let metadataMatch = "verified";
  const requests = new Map<number, any>();
  const calls: any[] = [];
  const native = {
    async annotationCacheNamespace() {
      return owner;
    },
    async assertLibraryUpload(id: number) {
      if (!allow || id === 999) throw new Error("Native access denied");
    },
    async getCollection() {
      return { id: 4, name: "Study", isOwner: true };
    },
    async uploadBook() {
      uploads++;
      if (failUpload) throw new Error("Upload response lost");
      return { bookId: 55 };
    },
    async getBook() {
      if (!allow) throw new Error("Native access denied");
      return { id: 55, libraryId: 7, files: [{ id: 9, format: "epub" }] };
    },
    async downloadFile() {
      return Buffer.from([80, 75, 3, 4, 0, 0]);
    },
    async changeCollectionBooks() {},
    async searchBooks() {
      return [{ id: 1, title: "Accessible", authors: [] }];
    },
    async searchBookMetadata() {
      return [
        {
          type: "result",
          candidate: {
            provider: "google",
            title: "Book",
            description: "Actual description",
            communityRating: 8,
            sourceUrl: "https://books.google.com/books?id=synthetic",
          },
        },
      ];
    },
  } as unknown as BookOrbitClient;
  const fetcher = (async (url: any, init: RequestInit) => {
    const path = new URL(String(url)).pathname,
      actor = new Headers(init.headers).get("Authorization")?.endsWith("A") ? 1 : 2;
    calls.push({ path, method: init.method, actor });
    const json = (v: unknown, status = 200) =>
      new Response(JSON.stringify(v), { status });
    if (path === "/api/v1/search")
      return json({ results: [{ work_id: "openlibrary:OL1W", title: "Book" }] });
    if (path === "/api/v1/book_research")
      return json({
        description: "Verified provider description",
        review_text_available: false,
      });
    if (path === "/api/v1/requests") {
      if (init.method === "POST") {
        const input = JSON.parse(String(init.body)),
          id = requests.size + 1;
        const r = {
          id,
          status: "searching",
          user: { id: actor },
          book: { work_id: input.work_id },
        };
        requests.set(id, r);
        return json({ requests: [r] });
      }
      return json({
        requests: [...requests.values()].filter((r) => r.user.id === actor),
      });
    }
    const id = Number(path.split("/")[4]),
      r = requests.get(id);
    if (!r || r.user.id !== actor) return json({}, 404);
    if (path.endsWith("/artifact"))
      return new Response(Buffer.from([80, 75, 3, 4, 0, 0]));
    if (path.endsWith("/search_results"))
      return json({ search_results: [{ id: 1, title: "EPUB" }], store_offers: [] });
    if (init.method === "DELETE") return json({ ...r, status: "failed" });
    return json({ ...r, status: completed ? "completed" : r.status });
  }) as typeof fetch;
  const service = new ProcurementService(
    native,
    config,
    join(dir, "jobs"),
    fetcher,
    async () => ({ metadataMatch, editionVerified: false }),
  );
  const input = {
    workId: "openlibrary:OL1W",
    title: "Book",
    author: "Writer",
    language: "en",
    libraryId: 7,
    dryRun: true,
  };
  const create = async () => {
    const p: any = await service.create(input);
    return service.create({ ...input, dryRun: false, expectedState: p.expectedState });
  };
  return {
    service,
    native,
    input,
    create,
    calls,
    config,
    dir,
    uploadCount: () => uploads,
    owner: (v: string) => {
      owner = v;
    },
    revoke: () => {
      allow = false;
    },
    complete: () => {
      completed = true;
    },
    failUpload: () => {
      failUpload = true;
    },
    metadata: (value: string) => {
      metadataMatch = value;
    },
  };
}

test("acquisition preview is read-only, binds identity/intent and prevents duplicate requests", async () => {
  const h = await setup();
  const p: any = await h.service.create(h.input);
  assert.equal(h.calls.length, 0);
  await assert.rejects(
    h.service.create({
      ...h.input,
      title: "Changed",
      dryRun: false,
      expectedState: p.expectedState,
    }),
  );
  h.owner("B");
  await assert.rejects(
    h.service.create({ ...h.input, dryRun: false, expectedState: p.expectedState }),
  );
  h.owner("A");
  const first: any = await h.create(),
    second: any = await h.create();
  assert.equal(first.job.id, second.job.id);
  assert.equal(h.calls.filter((c) => c.method === "POST").length, 1);
  assert.equal((await h.service.status()).jobs[0].state, "searching");
});

test("other users cannot inspect, cancel or grab a guessed job", async () => {
  const h = await setup(),
    created: any = await h.create();
  h.owner("B");
  await assert.rejects(h.service.status(created.job.id));
  await assert.rejects(h.service.status(created.job.id, "cancel"));
  await assert.rejects(h.service.releases(created.job.id, 1));
  assert.equal((await h.service.status()).jobs.length, 0);
});

test("completion imports once, persists across new service sessions and preserves job permissions", async () => {
  const h = await setup(),
    created: any = await h.create();
  h.complete();
  const done = await h.service.status(created.job.id);
  assert.equal(done.jobs[0].bookId, 55);
  assert.equal(done.jobs[0].state, "imported");
  await h.service.status(created.job.id);
  assert.equal(h.uploadCount(), 1);
  const saved = JSON.parse(await readFile(join(h.dir, "jobs", "A.json"), "utf8"));
  assert.equal(saved[0].bookId, 55);
  assert.equal(saved[0].sha256.length, 64);
});

test("revocation after queueing prevents native import and release grab", async () => {
  const h = await setup(),
    created: any = await h.create();
  h.complete();
  h.revoke();
  const done = await h.service.status(created.job.id);
  assert.equal(h.uploadCount(), 0);
  assert.ok(done.jobs[0].error);
  await assert.rejects(h.service.releases(created.job.id, 1));
});

test("uncertain upload is durable and never silently repeated by status polling", async () => {
  const h = await setup(),
    created: any = await h.create();
  h.complete();
  h.failUpload();
  const first = await h.service.status(created.job.id);
  assert.equal(first.jobs[0].state, "import_uncertain");
  await h.service.status(created.job.id);
  assert.equal(h.uploadCount(), 1);
  await assert.rejects(h.service.status(undefined, "reconcile_import"));
  const reconciled = await h.service.status(created.job.id, "reconcile_import", 55);
  assert.equal(reconciled.jobs[0].bookId, 55);
  assert.equal(h.uploadCount(), 1);
});

test("catalog/research results separate accessible books and missing review text", async () => {
  const h = await setup();
  const r = await h.service.discover("Book", 3);
  assert.equal(r.candidates.length, 1);
  assert.equal(r.accessibleCatalogMatches[0].bookId, 1);
  const researched = await h.service.research("openlibrary:OL1W", "Book");
  assert.equal(researched.metadataCandidates[0].communityRating, 8);
  assert.ok(researched.limitations.includes("Individual review text is not fetched"));
});

test("credential config must be owner-only and cancellations need explicit jobs", async () => {
  const h = await setup();
  await chmod(h.config, 0o644);
  await assert.rejects(h.service.status(), /owner-only/);
});

test("conflicting artifact metadata is held without publishing a native book", async () => {
  const h = await setup(),
    created: any = await h.create();
  h.complete();
  h.metadata("mismatch");
  const status = await h.service.status(created.job.id);
  assert.equal(status.jobs[0].state, "needs_review");
  assert.equal(h.uploadCount(), 0);
  await h.service.status(created.job.id);
  assert.equal(h.uploadCount(), 0);
});

test("missing metadata needs explicit opt-in bound to the acquisition preview", async () => {
  const h = await setup();
  h.complete();
  h.metadata("unverified");
  const input = { ...h.input, allowUnverifiedMetadata: true };
  const p: any = await h.service.create(input);
  const created: any = await h.service.create({
    ...input,
    dryRun: false,
    expectedState: p.expectedState,
  });
  assert.equal((await h.service.status(created.job.id)).jobs[0].state, "imported");
});

test("cancelling a completed but unimported acquisition never publishes or deletes a book", async () => {
  const h = await setup(),
    created: any = await h.create();
  h.complete();
  assert.equal(
    (await h.service.status(created.job.id, "cancel")).jobs[0].state,
    "cancelled",
  );
  assert.equal(h.uploadCount(), 0);
});

test("source retry is explicit, owned and rechecks current upload access", async () => {
  const h = await setup(),
    created: any = await h.create();
  assert.equal(
    (await h.service.status(created.job.id, "retry_search")).jobs[0].state,
    "searching",
  );
  assert.ok(h.calls.some((c) => c.path.endsWith("/retry_owned")));
  h.owner("B");
  await assert.rejects(h.service.status(created.job.id, "retry_search"));
  h.owner("A");
  h.revoke();
  const count = h.calls.filter((c) => c.path.endsWith("/retry_owned")).length;
  await h.service.status(created.job.id, "retry_search");
  assert.equal(h.calls.filter((c) => c.path.endsWith("/retry_owned")).length, count);
});
