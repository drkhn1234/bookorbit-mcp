# AI-assisted library organization

With `BOOKORBIT_EXTENSIONS=1`, three tools extend the existing browse, retrieval,
metadata and native file-organization tools. There are 51 tools in total.
No new model, index, scheduler or credential is needed. The authenticated AI client
interprets the request; BookOrbit stores the resulting collections and rules.

| Tool | Operations |
| --- | --- |
| `organization_options` | Discover supported filter fields/operators, sort fields and an example. |
| `manage_collection` | `create`, `update`, `add_books`, `remove_books`, `delete`. |
| `manage_smart_scope` | `get`, `create`, `update`, `delete`, with native match previews. |

Existing collection/scope browse tools continue to work. Native upstream endpoints
are used, including `POST /collections`, `PATCH /collections/:id`,
`POST`/`DELETE /collections/:id/books`, and equivalent scope routes. Deletes remove
only the collection or saved filter, never books, files, annotations or progress.

## Natural-language workflows

An AI client can fulfill requests such as:

- "Find connections between my physics and neuroscience books and create a study
  collection. Explain each inclusion using metadata or retrieved passages."
- "Create an unread English PDF smart scope, newest publications first."
- "Put these books in my exam preparation collection."
- "Review series assignments and correct actual volume order where supported by
  bibliographic evidence."

Use `get_related_books`, `search_passages`, `get_book` and existing catalog browse
tools to choose books. This is AI-assisted curation, not an exhaustive automatic
clustering pipeline. Collections are for themes/reading lists; series metadata is
for actual bibliographic series. An invented theme should not overwrite a series.

Native smart scopes execute metadata/status filter rules; they do not run a
semantic query or an LLM on every future import. A conceptual theme can be a
curated collection, or an explicit tag followed by a smart scope over that tag.
Recurring classification/tagging of future books is not enabled by these tools.

## Preview, then apply the same request

Writes default to `dryRun:true`. Read the preview, then repeat the same action,
target, patch and book selection with `dryRun:false` and its `expectedState`.
The digest binds the authenticated native account, request and current resource.
Modified requests, stale resources and account switches require a new preview.
These are optimistic checks, not native compare-and-swap transactions: concurrent
changes in the small interval after the final read are still possible.

Create a collection:

```json
{"action":"create","patch":{"name":"Information and Mind","description":"Connections grounded in my reading"}}
```

After applying it, add up to 100 explicit book IDs per call:

```json
{"action":"add_books","collectionId":12,"bookIds":[101,102]}
```

Collection creation and membership are separate native operations. If adding books
fails, the empty collection remains; inspect it and retry membership. Do not blindly
retry creates after a timeout: list shelves first. Duplicate visible names are
rejected by this bridge to avoid accidental repeated creation. Native uniqueness
and concurrency behavior remain upstream.

Create a scope:

```json
{
  "action":"create",
  "patch":{
    "name":"Unread English PDFs",
    "filter":{
      "type":"group","join":"AND","rules":[
        {"type":"rule","field":"language","operator":"eq","value":"en"},
        {"type":"rule","field":"format","operator":"includesAny","value":["pdf"]},
        {"type":"rule","field":"readProgress","operator":"isUnread"}
      ]
    },
    "defaultSort":[{"field":"publishedYear","dir":"desc"}]
  }
}
```

The preview queries the native catalog without saving a scope, returning a total
and at most 10 sample matches. Matches can change as permissions, metadata or reading
state change; the preview does not freeze membership or grant access.

Use `organization_options` for the supported subset of BookOrbit's filter syntax.
Groups use `AND`/`OR`, at most 5 levels and 100 nodes; the whole filter is capped at
32,000 characters. Facets take exact native **names**, not IDs (resolve names with
existing browse/`suggest_metadata` tools). Numeric fields take numbers, date rules
take `YYYY-MM-DD`, `withinLast` takes days, `between` uses `value` and `valueTo`,
and `is*` operators have no value. Custom metadata/community-provider filters and
additional newer native fields are not exposed in this initial subset. BookOrbit
still performs its own validation and current authorization on every request.

## Ownership, files and presentation

Creates are private unless `patch.isPublic:true` is explicit. Public shelf metadata
and filter rules can reveal your labels/interests; previews flag this. Sharing a
shelf never grants access to its books. Current native permissions and native
superuser behavior apply. Every selected collection book is checked before writing,
and native membership mutations also enforce access. No shared service account is
introduced, and changing shelves does not require re-embedding books or notes.

These tools do not configure Kobo sync. A collection's existing native sync behavior
can still react to membership changes; removing a shelf can remove that device's
shelf association under native policy. Book files and reading data are not deleted.

`update_book_metadata` already changes catalog values (including tags/series),
respecting native locks. `library_maintenance` previews/applies native naming
patterns to explicit books. Those operations can trigger configured native file
writes/renames; collection/scope operations do not change physical paths.

UI columns, card overlays and saved presentation preferences are separate from
folder structure and shelf filters. These tools do not modify them; some preferences
are browser-local. Shelf changes appear through BookOrbit's normal UI after refresh.

## Focused regression coverage

`node --import tsx --test test/organization.test.ts` exercises actual MCP transports
and the HTTP client against a stateful synthetic native API: schemas, read-only
previews, request/account/stale-state binding, owner denial, access revocation,
bounded nested rules, explicit membership and shelf-only deletion. Live installed
API/deployment evidence is maintained privately outside the public repository.
