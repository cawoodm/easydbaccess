# Visualizations — charts, maps and word clouds design

**Status:** proposed design, pre-implementation
**Date:** 2026-08-11

## Problem

easyDBAccess can show a table's rows three ways: the interactive grid
(`<data-table>`), an HTML-template View (`<view-window>`), and a Projection —
which *is* a `Table`, so it inherits both. All three are text in a rectangle.
There is no way to see a table as a **picture**: no chart, no map, no word
cloud. Nothing in the repo draws one.

We want visualisations that can live **in their own window** *or* be docked
**above or below** the grid inside an existing table, view or projection window,
so a chart sits with the rows it summarises instead of in a separate place the
user has to arrange next to it.

### Why a kind of View, and not a new top-level object

The obvious move is a new first-class `Visualization` object with its own
collection, its own manager dialog and its own window manager. It is the wrong
move here, because the Views system already solves — in core code, tested and
synced — every problem a visualisation has *except the drawing*:

| A visualisation needs | Views already has it |
|---|---|
| A reusable definition, workspace-global | `ViewTemplate` (`viewTemplates`) |
| That definition bound to one table | `ViewInstance` (`viewInstances`) |
| A channel → column mapping | `ViewInstance.mapping` — token → field today |
| Its own window, with persisted geometry | `window-mgr/view-window-manager.ts` |
| Open/closed across reloads | `ViewInstance.open` |
| Lazy mount, no fetch while minimized | the same manager |
| Survive its table being deleted and re-imported | reconnect-by-name, same manager |
| Filters / sort / row cap of its own | `filters`, `sortBy`, `limit` |
| Riding gist + server sync | `gist-sync` already pushes both collections |

A parallel stack would re-implement all of it. So a **Visualization is a
`ViewTemplate` whose `kind` is `'viz'`**, and the words compose: the thing the
user creates is a View that happens to draw rather than to lay out HTML.

Two facts make this genuinely cheap rather than merely tidy:

1. **No storage schema work.** `viewTemplates` / `viewInstances` are
   `DOC_COLLECTIONS` in `packages/electron/src/sqlite-store.ts` — whole JSON
   documents, not typed columns — and every field added below is non-indexed. The
   usual four-place lockstep (`types.ts` → `dexie-db.ts` →
   `data-store-dexie.ts` → `data-store-ipc.ts` + `sqlite-store.ts`) does **not**
   apply. Only `types.ts` changes.
2. **No migration.** Every new field is optional and absent means today's
   behaviour, so an existing workspace is already valid.

## Decisions (locked)

| Decision | Choice |
|---|---|
| Definition model | **A `ViewTemplate` kind** — no new collection, no third window manager |
| Channel binding | **Reuse `ViewInstance.mapping`** — channel key → column field |
| Drawing | **Bundled libraries, lazily `import()`ed** — never a CDN |
| Docking | **A panel-shell content stack**, above / primary / below, with splitters |
| Aggregation | **In the renderer, over the row set the grid already has** |
| v1 kinds | bar/column, line, pie, **map**, **word cloud** |
| Cross-filtering (click a bar → filter the grid) | **Deferred** |

Explicitly deferred, each a clean later addition: cross-filtering, aggregation
pushdown into the storage layer, 2-D dashboard layouts, chart image export.

## Data shapes

Added to `packages/shared/src/types.ts`.

On `ViewTemplate`:

```ts
/** Which kind of template this is. Absent ⇒ 'html' — every existing template. */
kind?: 'html' | 'viz' | undefined;
/** Present when `kind === 'viz'`. The three *Html fields stay ''. */
viz?: VizSpec | undefined;
```

```ts
export interface VizSpec {
  /** Which registered visualization draws this — a `VisualizationSpec.id`. */
  kind: string;
  /** How rows become series. Absent ⇒ the visualization's `defaultAggregate`. */
  aggregate?: VizAggregate | undefined;
  /** Values for the visualization's declared `options`, keyed by field key. */
  options?: Record<string, unknown> | undefined;
}

/**
 * How rows collapse into the categories and series a chart plots. Keyed by
 * CHANNEL, not by field: the channel → field indirection lives in
 * `ViewInstance.mapping`, so one template works on any table whose columns can be
 * mapped onto it.
 */
export interface VizAggregate {
  /** Group by these channel keys, in order. Empty ⇒ one group (a single number). */
  groupBy: string[];
  measures: Array<{
    channel: string;
    fn: 'count' | 'countDistinct' | 'sum' | 'avg' | 'min' | 'max';
  }>;
  /** Bin a numeric or date group key instead of grouping on exact values. */
  bin?:
    | {
        channel: string;
        width?: number | undefined;
        unit?: 'day' | 'week' | 'month' | 'quarter' | 'year' | undefined;
      }
    | undefined;
  /** Keep the top N groups by the first measure; the rest fold into "Other". */
  topN?: number | undefined;
  sort?: 'category' | 'value' | 'valueDesc' | undefined;
}
```

On `ViewInstance`, docking is one optional field:

```ts
/** Where this instance is shown. Absent ⇒ its own floating window (today). */
dock?: ViewDock | undefined;
```

```ts
export interface ViewDock {
  /** Which panel it is docked into. A table panel also covers a projection. */
  host: { kind: 'table'; tableId: string } | { kind: 'view'; viewInstanceId: string };
  edge: 'above' | 'below';
  /** Pane height in px, written by the splitter drag. */
  size: number;
  /** Order among the panes on the same edge, ascending. */
  order: number;
}
```

`host` is deliberately explicit rather than implied by `ViewInstance.tableId`.
They are usually the same table, but not always, and the difference is the
interesting case: a chart **of** a projection docked **into** the raw table's
window is how a KPI strip gets built.

## The plugin seam — one built-in per kind

Built-in features ARE plugins, so each kind (`bar`, `line`, `pie`, `map`,
`wordcloud`) is its own toggleable built-in in
`packages/renderer/src/plugins/`, registered in `plugin-host/loader.ts`. That
mirrors the `cell-date` / `cell-datetime` / `cell-boolean` split, which exists
precisely so the Plugin Manager can disable one without the others.

Added to `packages/shared/src/plugin-api.ts`:

```ts
export interface VizChannelSpec {
  /** Channel key — the key used in `ViewInstance.mapping`. UPPER_SNAKE by convention. */
  key: string;
  label: string;
  kind: 'category' | 'value' | 'series' | 'time' | 'lat' | 'lon' | 'text' | 'weight';
  /** Column types that may be mapped here; absent ⇒ any. */
  accepts?: ColumnType[] | undefined;
  required?: boolean | undefined;
  /** Several columns may be mapped here (e.g. multiple VALUE series). */
  multiple?: boolean | undefined;
}

export interface VisualizationSpec {
  /** Stable id stored in `VizSpec.kind` — 'bar', 'line', 'pie', 'map', 'wordcloud'. */
  id: string;
  label: string;
  /** Material Icons ligature name, or inline `<svg>` markup. */
  icon?: string | undefined;
  /** Custom element tag (must contain a hyphen). */
  tag: string;
  channels: VizChannelSpec[];
  /** Extra options, rendered generically. Same field shapes the Settings dialog uses. */
  options?: SettingsFieldSpec[] | undefined;
  /** What the element is handed: a grouped frame, or the raw rows. */
  data: 'aggregate' | 'rows';
  defaultAggregate?: VizAggregate | undefined;
}
```

and on `UiRegistry`:

```ts
/**
 * Register a visualization kind. `VizSpec.kind` opts a viz template into it, the
 * same way `column.renderer` opts a column into a cell renderer. The element
 * receives PROPERTIES — `.frame` (or `.rows`), `.columns`, `.config`, `.mapping`,
 * `.truncated` — never attributes.
 */
registerVisualization(spec: VisualizationSpec): Unregister;
```

Reusing **`SettingsFieldSpec`** for `options` is the economy that makes the
config editor nearly free: its type union (`'string' | 'text' | 'number' |
'boolean' | 'date' | 'secret' | 'option' | 'selection'`) already covers every
chart option, and the Settings dialog already renders those field shapes
generically. The options editor is an existing renderer pointed at a new field
list, not new UI — the same trick `ImporterSpec.panel` uses for per-importer
options.

### Not the dead `registerTableRenderer` slot

`UiRegistry` already declares `registerRowRenderer(viewName, tag)` and
`registerTableRenderer(viewName, tag)`, and `plugin-host/registries.ts` keeps
`rowRenderers` / `tableRenderers` maps for them. **Nothing anywhere reads either
map.** They are dead slots, and they are also the wrong shape: a bare name → tag
pair with no channels, no options and no icon, keyed by a "view name" that means
something else. Leave them alone — removing them is a public-contract break for a
URL plugin that might call them — and do not mistake them for this seam.

## The data contract

A chart needs aggregation, and **`RowQuery` has none**: `shared/src/row-query.ts`
is fields / filters / search / sort / offset / limit. Meanwhile a docked chart
that disagreed with the grid beside it would be worse than no chart at all.

### Where the rows come from

**A docked pane is told; a windowed viz asks.**

- **Docked** — `<data-table>` already computes exactly the right set in
  `filteredRows()` (per-column filters + local search + global search, before
  virtualisation), and already publishes a fact derived from it: `emitCount()`
  dispatches `easydb:visible-count`, which is how the panel titlebar shows
  `Name (3/12)` without holding a reference to the grid. Add a sibling
  `easydb:visible-rows`, keyed identically (view-instance id, else table id). The
  pane listens and never fetches.
- **Windowed** — there is no publisher, so the viz reads rows itself with
  `readRows(coll, RowRequest, cap)` from `db/row-reader.ts` and subscribes via
  `coll.watch ?? coll.subscribe`. That is exactly what `views/view-window.ts`
  already does.

Publishing is the right default for the docked case for two reasons. It makes
agreement **structural** rather than something two code paths have to keep
getting right; and reading independently would re-fetch a table the grid has
already fetched — the precise cost `row-query.ts`'s header comment was written
about (1483 ms and 15.4 MB to display about 30 rows).

Publishing a large array on every render is itself a cost, so
`table/visible-rows.ts` **counts listeners** and `<data-table>` dispatches only
when a pane is actually watching. Two existing modules are the models here:
`table/table-loading.ts`, which likewise keeps per-table state outside the
component, and `db/settings-events.ts`, whose `easydb:settings-changed` is
deliberately coarse and carries no value "so there is one source of truth and no
chance of the event and the store disagreeing". Copy its no-`document` guard
too: reporting a change must never be the thing that breaks the write it reports
on.

### The pure aggregator

`packages/renderer/src/viz/viz-aggregate.ts` — DOM-free, Dexie-free, no Lit, so
Vitest exercises it directly, as `views/view-render.ts` and
`plugins/projection-compute.ts` already are:

```ts
export interface VizFrame {
  /** One entry per group, in display order. */
  categories: Array<{
    key: string;
    label: string;
    /** The raw group values — what a future cross-filter would filter on. */
    values: unknown[];
  }>;
  series: Array<{ key: string; label: string; points: Array<number | null> }>;
  rowCount: number;
  /** The row set was capped, so this frame is a partial answer. */
  truncated: boolean;
}

export function aggregateRows(
  rows: readonly Row[],
  columns: readonly ColumnSpec[],
  mapping: Record<string, string>,
  spec: VizAggregate,
): VizFrame;
```

It lives in the renderer rather than `shared` for one reason: a **scripted
column** has no value until `util/column-script.ts` runs it in the renderer, so
aggregation must happen after script evaluation — the ordering
`view-window.ts`'s `recompute()` already respects. A chart of a computed column
is a normal thing to want.

### Telling the truth about big tables

v1 aggregates over a **capped** row set, and that must be visible rather than
silent — a bar chart over the first 20,000 of 600,000 rows looks exactly like a
bar chart over all of them. The pane shows a "first N of M" note built from the
existing `db/truncation-note.ts`, driven by the `QueryPage.truncated` /
`partial` flags `readRows` already propagates.

**Aggregation pushdown is a later phase with a named seam:** an optional
`DataCollection.aggregate?(q)`, feature-detected exactly like the existing
`query?()` / `watch?()` / `count?()`. The Electron SQLite store answers it with
`GROUP BY`; Dexie and every plugin provider simply don't implement it and the
renderer path stays. It is deliberately not v1 because it needs the
both-sides-must-agree treatment `filter-sql.ts` got — `row-query.ts` documents at
length what happens when a backend narrows differently from the in-memory
matcher, and an aggregate that quietly disagrees is the same failure with fewer
symptoms.

## Docking above and below

`createPanel()` takes a **single** `content: HTMLElement` plus an optional
`footerToolbar`. So `window-mgr/panel-stack.ts` introduces a first-party
vertical stack — `[above panes…][primary][below panes…]` — with drag splitters
between panes. Both window managers pass a `<panel-stack>` as `content` instead
of the bare element.

- **With no docked panes the stack holds only the primary child**, so behaviour
  is identical to today. That is what keeps this from being a risky change to
  `table-window-manager.ts`.
- `flex-direction: column`, primary `flex: 1`, panes at fixed pixel heights. So
  **maximize needs no new code** — the grid simply gets more room, and the
  shell's counter-transform for the pan/zoom canvas is untouched.
- **Lazy mount survives.** `mountContent` / `unmountContent` become build and
  tear-down of the *stack*, so minimizing still drops the grid **and** every pane
  with its subscriptions — the memory and no-fetch-while-minimized guarantees in
  `docs/tech/WINDOWS.md` keep holding.
- Splitter drags write `ViewDock.size` through the existing
  `queueGeometryWrite()`, which is what serialises the read-modify-write races
  between a panel's own callbacks.
- **One reconciler, not two.** `view-window-manager.ts`'s existing
  `viewInstances.subscribe()` already decides what should be open; extend that
  single decision — `open && !dock` opens a panel (today), `open && dock` mounts
  into the host panel's stack. Because view windows wrap their content in the
  same helper, "docked above a view" costs nothing extra.
- Pane chrome is a small `<viz-pane>` strip: title, collapse caret, "undock to
  window", close. Undocking clears `dock` and the same reconciler opens a window.

## Rendering

Bundled and **lazily imported**, never from a CDN: the app must work offline and
inside Electron, and GitHub Pages serves it under a strict origin.

| Need | Library | Why |
|---|---|---|
| bar / line / pie | `chart.js@4` | tree-shakeable registerables, canvas, documented `resize()` for a `ResizeObserver` |
| map | `leaflet@1.9` | raster OSM tiles, no WebGL |
| word cloud | `d3-cloud` | layout only, no d3 core; its output renders into our own SVG so styling stays in-house |

Each element does `await import('chart.js')` on first update, so none of this
lands in the initial bundle — Vite code-splits automatically, and under Electron
the chunks are local files. The `/* @vite-ignore */` gotcha does **not** apply
here: these are static specifiers and we want Vite to resolve them.

On whether to take the dependencies at all: the precedent people will reach for
is that jsPanel4 was deleted and `panel-shell/` written in its place. But the
newer precedent points the other way — the dialogs, toast and anchored menu were
just extracted *out* of the renderer into three SHA-pinned `@cawoodm/lit-*`
packages. The live convention is not "no dependencies", it is "own the reusable
UI and pin it precisely". That suggests a real option to weigh at implementation
time: ship these renderers as a `@cawoodm/lit-charts` package the same way. The
`registerVisualization` seam is identical either way, so it is a packaging
decision, not an architectural one.

- **Theming** — `viz/viz-theme.ts` reads the app's CSS custom properties at draw
  time, so dark mode and the panel accent colours carry through instead of a
  chart library imposing a second palette.
- **Maps offline** — the tile URL is a setting, so a self-hosted or air-gapped
  deployment can repoint it; when tiles fail the markers still draw on a plain
  background with a one-line notice. A chart is never blank merely because the
  network is. Declare it in a `viz/viz-settings.ts` namespace module copied from
  `table/grid-settings.ts`, for the dependency reason that file states outright:
  the `settings` plugin **registers** the fields and the viz element **reads**
  them, and neither may import the other. Re-read on `easydb:settings-changed`
  rather than caching, as the grid now does for `highlightNulls`.
- **Accessibility** — a canvas has no readable content, so each pane renders
  `role="img"` with an `aria-label` summarising the frame, plus a visually hidden
  `<table>` of the aggregated numbers. That doubles as the copy-the-numbers
  affordance.

## UI

- **`dialogs/views-dialog.ts`** gains a kind switch. Creating a template asks
  HTML or Visualization; a viz template picks its kind from the registered
  `VisualizationSpec`s (icon + label), then edits its `aggregate` and its
  `options` through the generic field renderer.
- **Channel mapping reuses the existing mapping UI**, because it is the same
  `Record<string,string>`. Auto-mapping applies the same heuristics the token
  auto-map already uses, narrowed by `VizChannelSpec.accepts`: a `value` channel
  prefers a `number` column, `time` a `date`/`datetime` one, `lat`/`lon` columns
  whose names contain the obvious words.
- **A per-table button** offers "Visualize" — create an instance of a viz
  template against this table, docked or windowed.

## Renames — one gap closed on the way past

A field rename is carried into **projection** specs
(`renameProjectionOutputs` / `renameProjectionSourceFields`, from
`dialogs/new-table-dialog.ts`'s `submit`) but **not** into
`ViewInstance.mapping`. `findTableReferences()` already takes `ViewInstance[]`,
so the plumbing exists — the field-rename step just never touches mappings.
Today that silently empties a renamed token in an HTML view; for a chart it would
silently plot nothing, which is harder to notice and easier to misread as "no
data". Add `renameViewMappings(instance, renames)` beside the projection helpers
and call it from the same `submit`. One fix, both features.

## Sync & delete — no changes needed

- **Sync:** `gist-sync` already pushes `viewTemplates` and `viewInstances` in
  `_easydb.workspace.json`, and every new field is plain JSON on those records.
  Nothing is added to the wire format.
- **Delete:** a visualisation holds no rows. Deleting its instance drops the
  record; deleting the bound table leaves the instance to reconnect by name, as
  an HTML view already does.

## Error handling

- **A channel mapped to a missing field** — the pane renders empty with a banner
  naming the field, never a blank chart. This is the case the rename fix above
  exists to prevent in the first place.
- **A required channel unmapped** — the editor refuses the save.
- **An unregistered `VizSpec.kind`** (its plugin disabled, or a URL plugin gone)
  — the pane says which kind is missing, exactly as an unregistered cell renderer
  falls back to text rather than erroring.
- **A non-numeric value in a `sum`/`avg` measure** — skipped, and the count of
  skipped rows shown in the pane's note. Coercing silently would invent data.

## Files touched

| File | Change |
|---|---|
| `packages/shared/src/types.ts` | + `VizSpec`, `VizAggregate`, `ViewDock`; + `ViewTemplate.kind`/`viz`; + `ViewInstance.dock` |
| `packages/shared/src/plugin-api.ts` | + `VisualizationSpec`, `VizChannelSpec`, `UiRegistry.registerVisualization` |
| `packages/renderer/src/plugin-host/registries.ts` | + `visualizations` map + the register fn |
| `packages/renderer/src/viz/viz-aggregate.ts` | new — the pure aggregator + `VizFrame` |
| `packages/renderer/src/viz/viz-panel.ts` | new — Lit host: resolve spec, get rows, aggregate, mount the element |
| `packages/renderer/src/viz/viz-theme.ts` | new — palette, CSS-var reads, dark mode |
| `packages/renderer/src/viz/viz-settings.ts` | new — settings namespace, mirroring `table/grid-settings.ts` |
| `packages/renderer/src/table/visible-rows.ts` | new — the `easydb:visible-rows` seam + listener counting |
| `packages/renderer/src/table/data-table.ts` | emit visible rows beside the existing `emitCount()` |
| `packages/renderer/src/window-mgr/panel-stack.ts` | new — above / primary / below stack + splitters |
| `packages/renderer/src/window-mgr/table-window-manager.ts` | wrap content in the stack |
| `packages/renderer/src/window-mgr/view-window-manager.ts` | reconcile docked instances; wrap content in the stack |
| `packages/renderer/src/plugins/viz-bar.ts`, `viz-line.ts`, `viz-pie.ts`, `viz-map.ts`, `viz-wordcloud.ts` | new built-ins, one per kind |
| `packages/renderer/src/plugins/settings.ts` | register the viz settings fields (it owns the tab) |
| `packages/renderer/src/plugin-host/loader.ts` | register the five |
| `packages/renderer/src/dialogs/views-dialog.ts` | the kind switch, channel mapping, options editor |
| `packages/renderer/src/table/table-references.ts` | + `renameViewMappings` |
| `packages/renderer/src/dialogs/new-table-dialog.ts` | call it from `submit` |
| `packages/renderer/package.json` | + `chart.js`, `leaflet`, `d3-cloud` |
| `docs/tech/VISUALIZATIONS.md` + `INDEX.md`, `PLUGINS.md`, `WINDOWS.md`, `docs/help/` | the tech and help write-ups |
| `test/renderer/viz/viz-aggregate.test.ts` | Vitest units |
| `test/e2e/104-visualizations.spec.ts`, `test/e2e/105-viz-docking.spec.ts` | Playwright |

## Testing

- **Unit (`viz-aggregate`)** — group by one and two channels; every aggregate
  fn; `topN` with "Other" folding; numeric and date binning; empty rows; a
  mapping pointing at a deleted field; `null` and blank group keys; non-numeric
  values in a `sum`; `truncated` propagation.
- **Integration (renderer + Dexie)** — an instance over a real table produces the
  expected frame; a scripted column aggregates on its computed value, not its
  stored one.
- **E2e (Playwright)** — build a viz template through the Views dialog over a
  fixture table and assert it draws and that the hidden numbers table matches;
  type a per-column filter in the grid and assert a docked pane's numbers change;
  drag a splitter and reload to assert `ViewDock.size` persisted; minimize the
  window and assert the pane unmounted. Fixture data goes through
  `test/e2e/helpers.ts` (`createTable`, `bulkAddRows`), not click flows.
