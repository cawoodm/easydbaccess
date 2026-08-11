# Visualizations

How a table becomes a picture — a bar/column/line/pie chart, a map or a word
cloud — in its own window or docked above or below a grid. Design notes:
[`../superpowers/specs/2026-08-11-data-visualizations-design.md`](../superpowers/specs/2026-08-11-data-visualizations-design.md).
For the HTML-template view system these share their storage with see
[`PLUGINS.md`](./PLUGINS.md)'s Views section, and for the windows around them
[`WINDOWS.md`](./WINDOWS.md).

## A visualization is a kind of View

There is no `visualizations` collection. A visualization is a **`ViewTemplate`
whose `kind` is `'viz'`**: instead of header/row/footer HTML it carries a
`VizSpec` (`{ kind, aggregate, options }`), and a `ViewInstance` binds it to one
table exactly as it binds an HTML template — same record, same fields.

That is not a shortcut, it is where all the behaviour comes from. Own windows,
persisted geometry, lazy mount/unmount on minimize, reconnect-by-name when a
bound table is deleted and re-imported, the `open` flag, and riding the gist /
server sync are all inherited from `window-mgr/view-window-manager.ts` and the
existing `viewTemplates` / `viewInstances` collections. Nothing was added to any
of them.

**`ViewInstance.mapping` is reused verbatim.** For an HTML view its keys are
template `$TOKEN`s; for a visualization they are **data channels** —
`CATEGORY`, `VALUE`, `SERIES`, `LAT`, `LON`, `TEXT`, `WEIGHT`. Same
`Record<string, string>`, same mapping UI in the Views dialog, same auto-mapping
pass. That is the single economy the whole design turns on.

Two consequences worth knowing:

- **No storage schema work was needed.** `viewTemplates` / `viewInstances` are
  `DOC_COLLECTIONS` in `packages/electron/src/sqlite-store.ts` — whole JSON
  documents, not typed columns — and every added field is optional and
  non-indexed. The usual four-place lockstep (`types.ts` → `dexie-db.ts` →
  `data-store-dexie.ts` → `data-store-ipc.ts` + `sqlite-store.ts`) does not apply.
  If a change there ever seems necessary, the field is modelled wrong.
- **No migration.** Absent `kind` means `'html'`, so every template that predates
  this is already valid.

## Registering a kind

Each drawing kind is registered by a plugin through
`api.ui.registerVisualization(spec)`, and a template opts into it by setting
`VizSpec.kind` — exactly as a column opts into a cell renderer via
`column.renderer`. `VisualizationSpec` declares:

| Field | What it does |
|---|---|
| `id` | The value stored in `VizSpec.kind` (`'bar'`, `'map'`, …) |
| `tag` | The custom element that draws |
| `channels` | The data slots, each with a `kind` (`category`/`value`/`time`/`lat`/`lon`/`text`/`weight`) and optional `accepts` type filter |
| `data` | `'aggregate'` (grouped) or `'rows'` (one mark per row) |
| `options` | Extra settings, as `SettingsFieldSpec[]` |
| `defaultAggregate` | Used when the template carries no `aggregate` |

`options` reusing **`SettingsFieldSpec`** is what makes a new chart option free:
the Views dialog renders those field shapes generically, the same way the
Settings dialog does, so an option is a line of data in a plugin rather than UI
code. The same trick `ImporterSpec.panel` uses.

### Not `registerTableRenderer`

`UiRegistry` also declares `registerRowRenderer` / `registerTableRenderer`, and
`plugin-host/registries.ts` keeps maps for them. **Nothing reads either map** —
they are dead slots, and the wrong shape anyway: a bare name → tag pair with no
channels, options or icon, keyed by a "view name" that means something else. They
are left alone (removing them would break the contract for a URL plugin that
calls them). Don't mistake them for this seam.

## The roster

| Plugin | Kinds | Library |
|---|---|---|
| `viz-charts` | `bar`, `column`, `line`, `pie` | `chart.js` |
| `viz-map` | `map` | `leaflet` |
| `viz-wordcloud` | `wordcloud` | `d3-cloud` |

Three plugins rather than one, **split by library**, so a user who wants bar
charts and no mapping can switch exactly that off — and so an offline deployment
has a reason to. The four chart kinds share one plugin because they share an
element, a dependency and a mental model; nobody wants "pie but not bar".

All three libraries are **lazily `import()`ed** inside the element's first draw,
so a user who never opens a chart downloads none of them. Verified against the
built bundle, not assumed: `getDatasetMeta` and `_tooltipItems` (Chart.js
internals) and `createTile` (Leaflet's) appear only in their own chunks and never
in the entry. A static import sneaking back in is the regression to watch for.

## Where the rows come from

Two paths, and the difference is the interesting part.

**A docked pane is told.** `<data-table>` already computes the right set in
`filteredRows()` — per-column filters, its own search box, and the app-wide
header search, before virtualization — and already publishes a fact derived from
it (`easydb:visible-count`, which is how a panel title shows `Name (3/12)`). So
`table/visible-rows.ts` publishes the row set itself and the pane listens. It
never reads the store.

Two reasons that is the default rather than each pane reading for itself. It
makes agreement **structural** instead of two code paths obliged to keep
producing the same answer; and reading independently would re-fetch a table the
grid has already read, which is the cost `shared/src/row-query.ts`'s header
comment documents at length (1483 ms and 15.4 MB to display about 30 rows).

**A windowed visualization asks.** There is no publisher, so `viz-panel.ts` reads
rows itself via `readRows(coll, RowRequest, cap)` and subscribes with
`coll.watch ?? coll.subscribe` — precisely what `views/view-window.ts` does.

### `visible-rows.ts` is a registry, not a document event

Its two siblings (`easydb:visible-count`, `db/settings-events.ts`) are
`document` CustomEvents; this one is a plain module-level registry. Two reasons:

- **Publishing must be conditional.** The payload is the whole filtered row set,
  so emitting per render for nobody would copy an array on every keystroke in a
  filter box. A registry answers "is anyone listening?" for free; with a document
  event that has to be bolted on beside it.
- **A registry is testable.** This repo's vitest runs with no DOM at all (see
  `TESTING.md`), so a `document`-dependent module can only ever be exercised by
  Playwright — and the bookkeeping here has rules in it.

A listener that throws is caught and warned about: a broken third-party chart is
a broken picture, not a broken table.

## Aggregation

`viz/viz-aggregate.ts` is pure — no DOM, no Dexie, no Lit — and turns rows plus a
`VizAggregate` into a `VizFrame` of categories and series. Three rules there are
deliberate, because each is a way a naive aggregator lies:

- **An empty group key is a category, not a row to drop.** "How many rows have no
  country" is a question charts get asked, and dropping them makes the bars add
  up to less than the table. It sorts last, labelled `(empty)`.
- **A non-numeric value is skipped and counted, never coerced.** `Number('')` is
  `0` and `Number('n/a')` is `NaN`: one invents a zero, the other poisons the
  whole sum. The count of skipped values is surfaced in the pane.
- **`topN` folds the tail into one "Other"**, ranked on the first measure
  regardless of display order. A chart that silently drops 200 small categories
  reads as though they do not exist.

An `array` (tags) column contributes **one group per member**, matching how the
grid's filter already matches per member. A **scripted column is evaluated
before aggregating** (`viz-panel.ts`'s `evaluatedRows`), because its value does
not exist until `util/column-script.ts` runs — aggregating the stored cell would
sum a column of blanks.

`RowQuery` has no aggregation, so all of this runs in the renderer over a capped
row set. That is why the pane reports a truncated read through
`db/truncation-note.ts` rather than quietly drawing a chart of the first 20,000
of 600,000 rows, which looks identical to a chart of all of them.

**Pushdown is deliberately not wired.** The seam when it is wanted: an optional
`DataCollection.aggregate?(q)`, feature-detected exactly like the existing
`query?()` / `watch?()` / `count?()`, answered with `GROUP BY` by the Electron
SQLite store and unimplemented everywhere else. It needs the
both-sides-must-agree treatment `filter-sql.ts` got first.

## Docking

`createPanel()` takes a **single** `content` element, so `window-mgr/panel-stack.ts`
holds `[panes above][primary][panes below]` with a drag splitter per pane. Both
window managers pass a stack as their content.

**An empty stack renders its primary child and nothing else** — one flex wrapper,
no listeners, no layout of its own. That is the property the design leans on,
since every table window in the app now goes through here, and it is pinned by an
e2e check on a plain table window rather than left to inspection.

- `flex-direction: column`, primary `flex: 1`, panes at fixed px. **Maximize
  needs no new code** — the grid just gets more room, and the shell's
  counter-transform for the pan/zoom canvas is untouched.
- `mountContent` / `unmountContent` build and tear down the *stack*, so
  minimizing still drops the grid **and** every pane with its subscriptions.
- Splitter releases persist `ViewDock.size` through `queueGeometryWrite()`, the
  same serialization every other geometry write uses. On release, not per
  pointermove, which would queue a store write per pixel.
- `stack-math.ts` holds the arithmetic, pure and unit-tested: a pane is clamped
  so the primary content keeps a floor, and a shrinking container **caps the tall
  panes to a common ceiling** rather than taking the whole excess off the
  largest — which turned two 300px panes in a 400px window into 48 and 272, a
  deletion rather than a shrink.

**One reconciler, not two.** `view-window-manager.ts`'s existing
`viewInstances.subscribe()` sends `open && !dock` to a window and `open && dock`
to `reconcileDockedPanes`, so toggling `dock` moves a visualization between the
two with no second source of truth. `panel-stacks.ts` is the registry that lets
it find a host stack without importing `table-window-manager.ts` — the same
decoupling `panel-registry.ts` and `shell-viewport.ts` already exist for. A host
appearing is not a store change, so the registry notifies too; otherwise a pane
whose host opened second would never appear.

## The elements are extraction-ready

Everything under `viz/elements/` is destined for standalone MIT packages
alongside `@cawoodm/lit-dialogs` / `lit-menu` / `lit-toast`, so **nothing there
may import `@easydb/shared`**. The elements take neutral shapes (`ChartData`,
`MapPoint[]`, `CloudTerm[]`) and read their theme from CSS custom properties
(`--viz-palette`, `--viz-grid`, `--viz-text`, …), never from configuration.

That makes `VizFrame` the adapter boundary: `viz-panel.ts` owns channels,
mapping and aggregation and hands the element plain data; the element owns
drawing, theming and resize. It is a better factoring than keeping them inside
the renderer would have produced, because it forces that seam to exist.

Elements are defined by explicit guarded `defineCharts()` / `definePointMap()` /
`defineWordCloud()` calls rather than Lit's `@customElement`, matching
`lit-dialogs`' `defineHostDialogs()`: a second `define` of the same tag throws,
which is reachable on an HMR reload or a module evaluated twice.

## Practical implications

- **A canvas has no readable content**, so every chart element renders a
  visually-hidden `<table class="a11y">` of the numbers beside it plus a
  `role="img"` summary. That is also what the e2e specs assert against — reading
  pixels would test Chart.js, not this app.
- **The map renders into the light DOM** (`createRenderRoot` returns `this`).
  Leaflet styles its panes with a global stylesheet and measures against the
  document; inside a shadow root it draws a grey box. Every other element keeps
  its shadow root.
- **Map markers are `circleMarker`, not `marker`.** The default Leaflet marker is
  an image resolved relative to the stylesheet, which is the thing that breaks
  under a bundler. A circle marker is SVG — no assets, and it can carry a
  magnitude by radius.
- **A tile failure is not a chart failure.** Tiles need the network; the points do
  not. When tiles fail the markers still draw and the pane says so, because a map
  that renders blank offline is indistinguishable from a map with no data. The
  tile URL is a workspace setting (Settings → Visualizations) so a self-hosted or
  air-gapped install can repoint it.
- **A field rename now reaches views too.** `renameViewMappings` in
  `table/table-references.ts` carries renames into `ViewInstance.mapping`,
  `visibleColumns`, both filter layers, `columnWidths` and the sort. This was a
  pre-existing gap that silently emptied a renamed token in an HTML view; for a
  chart it would silently plot nothing, which reads as "no data" rather than as a
  broken reference.
