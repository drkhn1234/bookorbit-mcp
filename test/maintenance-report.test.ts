import { test } from "node:test";
import assert from "node:assert/strict";
import { maintenanceReport } from "../src/maintenance-report.js";
import { BookOrbitError, type BookOrbitClient } from "../src/bookorbit-client.js";

test("maintenance exceptions use only current catalog IDs and withhold global names/provider details", async () => {
  const client = {
    async listLibraries() {
      return [{ id: 1, watch: true }];
    },
    async getFetchConfig() {
      return { enabled: true, triggerOnImport: true };
    },
    async getFetchStatus() {
      return {
        queued: 2,
        failed: 1,
        paused: false,
        currentItemName: "PRIVATE NOT RETURNED",
        apiKey: "NEVER RETURNED",
      };
    },
  } as unknown as BookOrbitClient;
  const books: any = [
    { id: 1, title: "A Book", authors: ["Synthetic"] },
    { id: 2, title: "A Book", authors: ["Synthetic"] },
  ];
  const r = await maintenanceReport(client, books, {
    indexed: 1,
    pending: [2],
    jobs: [
      { book_id: 1, state: "failed", error: "Test failure" },
      { book_id: 999, state: "failed", error: "PRIVATE NOT RETURNED" },
    ],
  });
  assert.equal(r.summary.indexingExceptions, 1);
  assert.equal(r.summary.possibleDuplicates, 1);
  assert.equal(r.libraries[0].metadataOnImport, true);
  assert.equal(r.originalDataChanged, false);
  assert.ok(!JSON.stringify(r).includes("PRIVATE NOT RETURNED"));
  assert.ok(!JSON.stringify(r).includes("NEVER RETURNED"));
});

test("ordinary accounts retain read-only report without metadata-management permissions", async () => {
  const client = {
    async listLibraries() {
      return [{ id: 1 }];
    },
    async getFetchConfig() {
      throw new BookOrbitError("Denied", 403, "/config");
    },
    async getFetchStatus() {
      throw new BookOrbitError("Denied", 403, "/status");
    },
  } as unknown as BookOrbitClient;
  const r = await maintenanceReport(client, [], { indexed: 0, pending: [], jobs: [] });
  assert.equal(r.metadataQueue, null);
  assert.equal(r.libraries[0].metadataOnImport, null);
});
