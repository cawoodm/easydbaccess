# Row Memory: What's Loaded, and What Isn't

How much of a table's data actually sits in browser memory at once?

- Open Tables: Everything
- Minimized Tables: Nothing

How much of a tables data is rendered as HTML?

- Small tables (<200 rows): Everything
- Large tables: As required (virtualization)

## Local (Dexie) tables load in full

`<data-table>.connectedCallback()` calls `rowColl.find()` and assigns the
entire result straight to `this.rows`
([`table/data-table.ts:575`](../../packages/renderer/src/table/data-table.ts)).
There is no row limit, no cursor, no server-side paging — every row in the
underlying Dexie `rows` table for that `tableId` is pulled into a plain JS
array the instant the table's window mounts.

`VIRT_THRESHOLD = 200`
([`data-table.ts:409`](../../packages/renderer/src/table/data-table.ts))
is easy to mistake for a memory bound — it isn't. It only gates
`virtualSlice()`, which decides how many `<tr>` DOM nodes get rendered for
the current scroll position. Sort, filter, and search all still run in JS
over the full `this.rows` array regardless of how many rows are actually
painted to the DOM.

## Live/remote sources cap at import, not at display

A table backed by a `TableSource` (currently only `datasette`, via
`registerRowSource`) goes through
[`datasette-collection.ts`](../../packages/renderer/src/plugins/datasette-collection.ts)
instead of Dexie. Its `find()` fetches once, caches the result in a closure
variable, and returns that cache on every subsequent call until `refresh()`
is invoked (`datasette-collection.ts:131`) — so scrolling or re-rendering
never triggers another network round-trip, but the whole fetched set stays
resident for the table's lifetime.

The fetch itself is capped at `maxRows` — default `10_000`
(`datasette-collection.ts:66`, same default as the importer's
`SETTINGS.maxImportRows` in
[`datasette-source.ts:200`](../../packages/renderer/src/plugins/datasette-source.ts)) —
pulled in `pageSize: 1000` hops
(`datasette-source.ts:201`). This is a **bulk-fetch cap**, not a viewport
window: opening a live table with 8,000 rows loads all 8,000 before the grid
renders anything, identical in spirit to a local table's `find()`. A
**Reference** table (see `PLUGINS.md`'s Import section) is not cheaper here
than a **Copy** — the only difference is persistence (a Reference's rows
never get written to Dexie), not how much ends up in memory while it's open.

Going over the cap doesn't fail the import/connect — it truncates and warns
(`datasette-source.ts:1086`, "capped at 10000 — more available"), per the
TODO history: importing a referenced table is no longer blocked outright
for being large, it's silently capped instead.

## What actually keeps memory bounded today

Nothing shrinks a single table's footprint. The existing mitigations are
about **how many tables are loaded at once**, not how much of one table is:

- **Minimizing unmounts the grid.** `onstatuschange` in
  [`window-mgr/jspanel-manager.ts`](../../packages/renderer/src/window-mgr/jspanel-manager.ts)
  detaches `<data-table>` entirely when a panel minimizes and mounts a fresh
  one when it's expanded again — so a minimized table holds no rows and no
  store subscription. A table that _boots_ already minimized never mounts a
  grid, and so never fetches, until the user expands it. See `WINDOWS.md`'s
  "Minimize unmounts the grid" section.
- **`?safemode` / `?safemode1`** (transient boot flags,
  [`plugin-host/safe-mode.ts`](../../packages/renderer/src/plugin-host/safe-mode.ts))
  skip loading optional/URL plugins for one boot. This helps when a plugin's
  _code_ is what's hanging the tab, but does nothing for the row count of an
  otherwise-normal table — it's a different failure mode than the one this
  page is about.

## Not yet on `main`

- **`?minimize`** — a boot flag that forces every table to open minimized
  regardless of its saved geometry, so a workspace full of huge tables can
  be opened without any of them fetching. Implemented on the `importers`
  branch (`jspanel-manager.ts`'s `FORCE_MINIMIZED` constant), not yet merged.
- **True windowed/lazy paging** — fetch-on-scroll with sort/filter pushed to
  the server, so a 100k-row remote table never has more than a page or two
  resident. Designed but no code written: see
  `.claude/plans/2026-07-26-datasette-virtual-tables-design.md` (parked in
  `TODO.md`). Until this lands, the practical ceiling for any single table
  — local or remote — is "however many rows fit in the tab's memory,"
  full stop.

## Practical implications

- **Don't treat `VIRT_THRESHOLD` as a memory safeguard.** It only affects
  paint cost; a 50,000-row local table still loads and holds all 50,000
  rows as JS objects, it just doesn't render 50,000 `<tr>`s.
- **A Reference isn't a lighter-weight table while it's open** — only
  lighter-weight to keep around (no sync, no Dexie persistence). Both
  Reference and Copy hit the same `maxRows` cap and hold the full capped
  result in memory once loaded.
- **The only current lever for a huge workspace is keeping tables
  minimized** so they never mount/fetch — there's no way today to open a
  table and only pay for the rows actually visible.
