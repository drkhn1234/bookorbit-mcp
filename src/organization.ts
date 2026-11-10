import { createHash } from "node:crypto";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { BookOrbitClient } from "./bookorbit-client.js";
import type { NamedShelf } from "./types.js";

// Bounded subset of BookOrbit's native GroupRule contract. The native validator
// and query builder remain authoritative; these are not SQL or vector predicates.
const text = [
  "contains",
  "notContains",
  "startsWith",
  "endsWith",
  "eq",
  "notEq",
  "isEmpty",
  "isNotEmpty",
];
const numeric = [
  "eq",
  "notEq",
  "gt",
  "gte",
  "lt",
  "lte",
  "between",
  "isEmpty",
  "isNotEmpty",
];
const facets = ["includesAny", "includesAll", "excludesAll", "isEmpty", "isNotEmpty"];
const dates = ["before", "after", "between", "withinLast", "isEmpty", "isNotEmpty"];
export const scopeFields: Record<string, string[]> = {
  title: text,
  publisher: [
    "contains",
    "notContains",
    "eq",
    "notEq",
    "includesAny",
    "excludesAll",
    "isEmpty",
    "isNotEmpty",
  ],
  language: ["eq", "notEq", "includesAny", "excludesAll", "isEmpty", "isNotEmpty"],
  series: [
    "contains",
    "notContains",
    "eq",
    "notEq",
    "includesAny",
    "excludesAll",
    "isEmpty",
    "isNotEmpty",
  ],
  author: facets,
  genre: facets,
  tag: facets,
  collection: ["includesAny", "excludesAll", "isEmpty", "isNotEmpty"],
  library: ["includesAny", "excludesAll"],
  format: ["includesAny", "excludesAll"],
  seriesIndex: numeric,
  publishedYear: numeric,
  fileSize: numeric,
  pageCount: numeric.filter((v) => !["eq", "notEq"].includes(v)),
  rating: ["eq", "gt", "gte", "lt", "lte", "isEmpty", "isNotEmpty"],
  addedAt: dates.filter((v) => !["isEmpty", "isNotEmpty"].includes(v)),
  startedAt: dates,
  finishedAt: dates,
  readProgress: ["isUnread", "isInProgress", "isFinished"],
  readStatus: ["includesAny", "excludesAll", "isEmpty", "isNotEmpty"],
  fileAvailability: ["isMissing", "isPresent"],
  description: ["isEmpty", "isNotEmpty"],
  isbn: ["eq", "isEmpty", "isNotEmpty"],
  cover: ["isMissing", "isPresent"],
  lockStatus: ["isLocked", "isUnlocked"],
};
const sorts = [
  "title",
  "author",
  "series",
  "seriesIndex",
  "addedAt",
  "updatedAt",
  "publishedYear",
  "pageCount",
  "rating",
  "publisher",
  "fileSize",
  "readProgress",
  "readStatus",
  "format",
  "lastReadAt",
  "startedAt",
  "finishedAt",
  "language",
] as const;
const scalar = z.union([z.string().max(1000), z.number().finite()]);
const ruleSchema = z
  .object({
    type: z.literal("rule"),
    field: z.string(),
    operator: z.string(),
    value: z
      .union([
        scalar,
        z.array(z.string().min(1).max(1000)).min(1).max(20),
        z.array(z.number().finite()).min(1).max(20),
      ])
      .optional(),
    valueTo: scalar.optional(),
  })
  .strict();
type Rule = z.infer<typeof ruleSchema>;
type Group = { type: "group"; join: "AND" | "OR"; rules: (Rule | Group)[] };
const groupSchema: z.ZodType<Group> = z.lazy(() =>
  z
    .object({
      type: z.literal("group"),
      join: z.enum(["AND", "OR"]),
      rules: z
        .array(z.union([ruleSchema, groupSchema]))
        .min(1)
        .max(100),
    })
    .strict(),
);

export function validateScopeFilter(input: unknown): Group {
  if (JSON.stringify(input)?.length > 32000)
    throw new Error("Filter exceeds 32,000 characters");
  // Check structure/depth before recursive parsing, including maliciously deep input.
  let nodes = 0;
  const bound = (v: any, depth: number) => {
    if (++nodes > 100 || depth > 5)
      throw new Error("Filter permits at most 100 nodes and 5 group levels");
    if (v?.type === "group" && Array.isArray(v.rules)) {
      for (const child of v.rules)
        bound(child, depth + (child?.type === "group" ? 1 : 0));
    }
  };
  bound(input, 1);
  const group = groupSchema.parse(input);
  const visit = (v: Rule | Group) => {
    if (v.type === "group") return v.rules.forEach(visit);
    if (
      !Object.hasOwn(scopeFields, v.field) ||
      !scopeFields[v.field].includes(v.operator)
    )
      throw new Error(
        `Unsupported field/operator: ${v.field}/${v.operator}; use organization_options`,
      );
    if (v.operator.startsWith("is")) {
      if (v.value !== undefined || v.valueTo !== undefined)
        throw new Error("Presence/state operators take no value");
      return;
    }
    if (["includesAny", "includesAll", "excludesAll"].includes(v.operator)) {
      if (!Array.isArray(v.value) || !v.value.length)
        throw new Error(
          "Membership operators require a nonempty array of exact native names",
        );
      if (!v.value.every((x) => typeof x === "string"))
        throw new Error("Use native facet names, not numeric IDs");
    } else if (
      ["seriesIndex", "publishedYear", "pageCount", "rating", "fileSize"].includes(
        v.field,
      )
    ) {
      if (
        typeof v.value !== "number" ||
        (v.operator === "between" && typeof v.valueTo !== "number")
      )
        throw new Error("Numeric rules require numbers (between also requires valueTo)");
      if (v.operator === "between" && v.value > (v.valueTo as number))
        throw new Error("Range is reversed");
    } else if (v.operator === "withinLast") {
      if (typeof v.value !== "number" || v.value < 0 || !Number.isInteger(v.value))
        throw new Error("withinLast requires a nonnegative integer number of days");
    } else if (["addedAt", "startedAt", "finishedAt"].includes(v.field)) {
      const validDate = (x: unknown) =>
        typeof x === "string" &&
        /^\d{4}-\d{2}-\d{2}$/.test(x) &&
        !Number.isNaN(Date.parse(x)) &&
        new Date(x).toISOString().slice(0, 10) === x;
      if (!validDate(v.value) || (v.operator === "between" && !validDate(v.valueTo)))
        throw new Error("Date rules require YYYY-MM-DD values");
    } else if (typeof v.value !== "string" || !v.value.length)
      throw new Error("Text rules require a nonempty string");
    if (v.operator !== "between" && v.valueTo !== undefined)
      throw new Error("valueTo is only valid with between");
  };
  visit(group);
  return group;
}

const id = z.number().int().positive();
const displayPatch = {
  name: z.string().trim().min(1).max(255).optional(),
  icon: z.string().trim().min(1).max(100).optional(),
  isPublic: z.boolean().optional(),
};
const collectionPatch = z
  .object({ ...displayPatch, description: z.string().max(1000).optional() })
  .strict();
const scopePatch = z
  .object({
    ...displayPatch,
    // Explicit outer shape for MCP schema discovery; recursive validation runs above.
    filter: z
      .object({
        type: z.literal("group"),
        join: z.enum(["AND", "OR"]),
        rules: z.array(z.record(z.unknown())).min(1).max(100),
      })
      .strict()
      .optional(),
    defaultSort: z
      .array(z.object({ field: z.enum(sorts), dir: z.enum(["asc", "desc"]) }).strict())
      .max(5)
      .optional(),
  })
  .strict();
const confirmation = {
  dryRun: z.boolean().default(true),
  expectedState: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
};
const cleanShelf = (s: NamedShelf) =>
  Object.fromEntries(
    [
      "id",
      "name",
      "icon",
      "description",
      "isPublic",
      "isOwner",
      "userId",
      "filter",
      "defaultSort",
      "bookCount",
      "updatedAt",
    ]
      .filter((k) => s[k] !== undefined)
      .map((k) => [k, s[k]]),
  );
// Dynamic counts don't invalidate edits as people read. Intent and authenticated
// owner scope are included so a preview cannot be reused for another operation.
const stableShelf = (s: NamedShelf) => {
  const { bookCount: _count, isOwner: _owner, ...rest } = cleanShelf(s);
  return rest;
};
const stableJson = (v: any): string =>
  JSON.stringify(v, (_key, value) =>
    value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((k) => [k, value[k]]),
        )
      : value,
  );
const digest = (v: unknown) => createHash("sha256").update(stableJson(v)).digest("hex");
const result = (v: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(v) }],
});
const guard = async (fn: () => Promise<unknown>) => {
  try {
    return result(await fn());
  } catch (error) {
    return { ...result({ error: (error as Error).message }), isError: true };
  }
};

export function registerOrganizationTools(server: McpServer, client: BookOrbitClient) {
  server.registerTool(
    "organization_options",
    {
      description:
        "Read supported native smart-scope fields/operators, sort fields and examples. Use exact facet names from suggest_metadata. Translate user intent into rules; semantic themes require a curated collection or explicit tags. No model/classification job runs on future imports automatically.",
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      inputSchema: {},
    },
    async () =>
      result({
        fields: scopeFields,
        sortFields: sorts,
        filterShape: {
          type: "group",
          join: "AND or OR",
          rules: "rule or nested group; max 5 levels, 100 nodes, 32000 characters",
        },
        values:
          "Facet arrays contain exact names (library, collection, author, genre, tag, format). Text uses strings; numeric fields use numbers; between uses value and valueTo; dates YYYY-MM-DD; withinLast uses days; is* operators have no value.",
        example: {
          name: "Unread English PDFs",
          filter: {
            type: "group",
            join: "AND",
            rules: [
              { type: "rule", field: "language", operator: "eq", value: "en" },
              { type: "rule", field: "format", operator: "includesAny", value: ["pdf"] },
              { type: "rule", field: "readProgress", operator: "isUnread" },
            ],
          },
          defaultSort: [{ field: "publishedYear", dir: "desc" }],
        },
        boundaries:
          "Shelves do not grant book access. Public shelf names/descriptions/rules are visible to others: choose explicitly. Collections group themes; series metadata represents actual bibliographic series. Physical file naming uses library_maintenance. Browser-local display preferences are separate.",
      }),
  );

  const annotations = {
    readOnlyHint: false,
    destructiveHint: true,
    openWorldHint: false,
  };
  server.registerTool(
    "manage_collection",
    {
      description:
        "Create/update/delete a native BookOrbit collection or add/remove explicit books (max 100). Defaults to dryRun: inspect then repeat identical arguments with dryRun=false and returned expectedState. Creates are private by default. Delete removes only the shelf, never its books. Native ownership and current book access apply; no filesystem changes. Use search_passages/get_related_books to curate related books, not invented series metadata.",
      annotations,
      inputSchema: {
        action: z.enum(["create", "update", "add_books", "remove_books", "delete"]),
        collectionId: id.optional(),
        patch: collectionPatch.optional(),
        bookIds: z.array(id).min(1).max(100).optional(),
        ...confirmation,
      },
    },
    async ({ action, collectionId, patch = {}, bookIds, dryRun, expectedState }) =>
      guard(async () => {
        if (action === "create" ? collectionId !== undefined : collectionId === undefined)
          throw new Error("collectionId is required except for create");
        const membership = action === "add_books" || action === "remove_books";
        if (membership !== Boolean(bookIds?.length))
          throw new Error(
            "bookIds is required only for add_books/remove_books; create the empty shelf first",
          );
        if ((membership || action === "delete") && Object.keys(patch).length)
          throw new Error("This action does not accept patch");
        if (action === "update" && !Object.keys(patch).length)
          throw new Error("Update patch is empty");
        if (action === "create" && !patch.name)
          throw new Error("Create requires patch.name");
        const body =
          action === "create" ? { icon: "pi pi-book", isPublic: false, ...patch } : patch;
        const scope = await client.annotationCacheNamespace();
        const current =
          collectionId === undefined
            ? null
            : ((await client.getCollection(collectionId)) as NamedShelf);
        const existing = action === "create" ? await client.listCollections() : [];
        if (action === "create" && existing.some((s) => s.name === patch.name))
          throw new Error(
            "A visible collection with this name already exists; inspect it instead of creating another",
          );
        const selected = [];
        for (const bookId of [...new Set(bookIds ?? [])].sort((a, b) => a - b)) {
          const book = await client.getBook(bookId); // Reject entire selection before writing if any book is inaccessible.
          selected.push({ id: book.id, title: book.title, libraryId: book.libraryId });
        }
        // A bounded membership snapshot detects changes to the selected books; no full-shelf scan.
        const memberships = selected.length
          ? await client.collectionMembership(selected.map((b) => b.id))
          : [];
        const state = digest({
          scope,
          action,
          collectionId,
          body,
          selected,
          memberships,
          current: current && stableShelf(current),
          existing: existing
            .map((s) => ({ id: s.id, name: s.name }))
            .sort((a, b) => a.id - b.id),
        });
        if (dryRun)
          return {
            dryRun: true,
            expectedState: state,
            action,
            collectionId,
            current: current && cleanShelf(current),
            changes: body,
            books: selected,
            warning: body.isPublic
              ? "Public shelf metadata will be visible to other users; book access is unchanged"
              : undefined,
          };
        if (state !== expectedState)
          throw new Error(
            "State/selection/request changed or preview missing; run dryRun again",
          );
        if (action === "delete") {
          await client.deleteShelf("collections", collectionId!);
          return {
            applied: true,
            deletedCollectionId: collectionId,
            booksDeleted: false,
          };
        }
        const updated =
          action === "create"
            ? await client.createShelf("collections", body)
            : action === "update"
              ? await client.updateShelf("collections", collectionId!, body)
              : await client.changeCollectionBooks(
                  collectionId!,
                  action,
                  selected.map((b) => b.id),
                );
        return { applied: true, collection: cleanShelf(updated) };
      }),
  );

  server.registerTool(
    "manage_smart_scope",
    {
      description:
        "Get/create/update/delete a native rule-based smart scope. Read organization_options for filter syntax. Create requires name and filter; native query preview returns up to 10 currently authorized matches. Private by default. Writes require dryRun preview then identical request with dryRun=false and expectedState. Rules dynamically match future metadata, not semantic meaning. No book permission, metadata or file changes.",
      annotations,
      inputSchema: {
        action: z.enum(["get", "create", "update", "delete"]),
        scopeId: id.optional(),
        patch: scopePatch.optional(),
        ...confirmation,
      },
    },
    async ({ action, scopeId, patch = {}, dryRun, expectedState }) =>
      guard(async () => {
        if (action === "create" ? scopeId !== undefined : scopeId === undefined)
          throw new Error("scopeId is required except for create");
        if ((action === "get" || action === "delete") && Object.keys(patch).length)
          throw new Error("This action does not accept patch");
        if (action === "update" && !Object.keys(patch).length)
          throw new Error("Update patch is empty");
        if (action === "create" && (!patch.name || !patch.filter))
          throw new Error("Create requires patch.name and patch.filter");
        const body =
          action === "create"
            ? { icon: "pi pi-filter", isPublic: false, defaultSort: [], ...patch }
            : { ...patch };
        if (patch.filter) body.filter = validateScopeFilter(patch.filter);
        const scope = await client.annotationCacheNamespace();
        const current =
          scopeId === undefined ? null : await client.getSmartScope(scopeId);
        if (action === "get") return { smartScope: cleanShelf(current!) };
        const existing = action === "create" ? await client.listSmartScopes() : [];
        if (action === "create" && existing.some((s) => s.name === patch.name))
          throw new Error(
            "A visible smart scope with this name already exists; inspect it instead of creating another",
          );
        const state = digest({
          scope,
          action,
          scopeId,
          body,
          current: current && stableShelf(current),
          existing: existing
            .map((s) => ({ id: s.id, name: s.name }))
            .sort((a, b) => a.id - b.id),
        });
        if (dryRun) {
          const filter = body.filter ?? current?.filter;
          const matches =
            action !== "delete" && filter
              ? await client.previewScope(
                  filter,
                  body.defaultSort ?? current?.defaultSort ?? [],
                )
              : null;
          return {
            dryRun: true,
            expectedState: state,
            action,
            scopeId,
            current: current && cleanShelf(current),
            changes: body,
            matches: matches && {
              total: matches.total,
              sample: matches.items.map((b) => ({
                id: b.id,
                title: b.title,
                authors: b.authors,
              })),
              sampleLimit: 10,
            },
            warning: body.isPublic
              ? "Public shelf metadata/rules will be visible to other users; book access is unchanged"
              : undefined,
          };
        }
        if (state !== expectedState)
          throw new Error("State/request changed or preview missing; run dryRun again");
        if (action === "delete") {
          await client.deleteShelf("smart-scopes", scopeId!);
          return { applied: true, deletedScopeId: scopeId, booksDeleted: false };
        }
        const updated =
          action === "create"
            ? await client.createShelf("smart-scopes", body)
            : await client.updateShelf("smart-scopes", scopeId!, body);
        return { applied: true, smartScope: cleanShelf(updated) };
      }),
  );
}
