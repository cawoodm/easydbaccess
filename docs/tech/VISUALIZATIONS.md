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
  non-indexed. The usual lockstep (`types.ts` → `dexie-db.ts` →
  `data-store-dexie.ts` → `data-store-bridge.ts` + `sqlite-store.ts` +
  `shared/src/edb-store.ts`) does not apply.
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
| `viz-custom` | `custom` | none |

The first three are split **by library**, so a user who wants bar
charts and no mapping can switch exactly that off — and so an offline deployment
has a reason to. The four chart kinds share one plugin because they share an
element, a dependency and a mental model; nobody wants "pie but not bar".

All three libraries are **lazily `import()`ed** inside the element's first draw,
so a user who never opens a chart downloads none of them. Verified against the
built bundle, not assumed: `getDatasetMeta` and `_tooltipItems` (Chart.js
internals) and `createTile` (Leaflet's) appear only in their own chunks and never
in the entry. A static import sneaking back in is the regression to watch for.

`viz-custom` carries no library at all and is the odd one out in two more ways.
It declares `channels: []` — its markup names the columns it reads, so there is
nothing for the mapping dialog to ask about — and it is the first visualization
to WRITE to its host: a `$filter.FIELD` pill calls `table/pane-actions.ts`, the
mirror of `visible-rows.ts`. That seam is deliberately not custom-visualization
machinery; making a bar click filter the grid is now a few lines in
`chart-element.ts`.

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

### Push for updates, PULL for the initial value

Publishing alone is not enough, and the reason is a mount order nobody controls:
a pane mounts AFTER the host grid has rendered, and the grid publishes only when
something is already listening. So the first publish the new pane could hear is
the grid's next render — which, on a table nobody is touching, never comes. The
pane sat on "No data to chart." beside a full grid, and a window resize (any
re-render at all) fixed it, which is what the bug looked like from outside.

Three parts close it, and all three are needed:

- `provideVisibleRows(key, fn)` / `requestVisibleRows(key)` — the grid registers
  a provider, so a late listener can ask instead of wait. `viz-panel`'s docked
  branch pulls immediately after it starts watching.
- The grid keeps its rendered row set **unconditionally**. Keeping it only while
  something was listening was the same bug from the other side: at the render
  before the pane existed, nothing was kept, so the publish in `updated()` had
  nothing to send. It is a reference to an array the render already built.
- A pane that pulls and gets `null` — the grid is not mounted yet, which happens
  on a reload where both mount at once — stays on "Loading…" rather than claiming
  to be loaded with no rows. Otherwise a reloaded word cloud reported "No words
  to show.", which reads as a verdict on the data rather than as "not yet".

A windowed table (`grid:windowRowsFrom`, where `rows` is one 500-row page of the
matching set) publishes with `truncated: true`. A chart of a page is a chart of a
slice, and one that moves as the user scrolls; the pane's truncation note is how
it says so.

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

### Why a chart is blank, said out loud

Three different blanks, three different messages, because they need three
different fixes and all look identical on screen (`viz/viz-diagnose.ts`, pure):

| Cause | Message points at |
|---|---|
| A channel maps to a field **no column carries** (a renamed column) | the broken reference, naming the channel — from `viz-aggregate.ts` |
| A channel maps to a column that **exists and is empty** | the mapping: names the column, the row count, and the Edit button |
| A word cloud's column **holds text but yielded no terms** | the word rules behind Chart — min length, stop words, numbers — never the mapping, because the column is fine |

The middle one is the commonest and was silent until a user hit it: picking the
wrong column out of a dropdown of a dozen is easy, and a blank pane taught them
nothing. The third is kept separate on purpose — "pick a different column" is
actively wrong advice when the column has text in it.

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

## Options come in three layers

A value can be set in three places, and each exists for a different reason
(`viz/viz-options.ts`, pure):

| Layer | Where | What it is for |
|---|---|---|
| Workspace | Settings → Visualizations | The **defaults a new visualization starts with** |
| Template | `VizSpec.options` | The shared definition — one chart used against five tables |
| Instance | `ViewInstance.vizOptions` | This view of that template |

The workspace layer is **copied in at creation**, not read at draw time — unlike
the map's tile URL, which is read live. The difference is deliberate: a tile
server is infrastructure and should change everywhere at once, while a word list
is editorial, and changing a default must not silently rewrite a cloud somebody
already tuned.

The instance layer stores **only the keys it actually changes**
(`overrideDelta`). Storing the full resolved set would freeze a copy, and a later
template edit would stop reaching the instance — inheritance that quietly stops
inheriting is worse than none. The editor marks an overridden field and offers
Reset, which returns it to *inheriting* rather than to the field's built-in
default; those are different things.

Both editors render from the same `SettingsFieldSpec[]` through one
`renderVizOptionField`, so a new option declared by a plugin appears in the
template editor and in every instance's override list at once, with no UI code.

### The aggregate is layered too

`VizAggregate` — which function over the value column, in what order, how many
groups — was template-only until v0.0.370, so "sum this table but count that
one" meant forking the template. `ViewInstance.vizAggregate` is the same delta
layer applied to it (`effectiveAggregate` / `aggregateOverrideDelta`).

It is a **named three-field override**, not `Partial<VizAggregate>`:

```ts
interface VizAggregateOverride { fn?; sort?; topN? }
```

`groupBy`, `measures[].channel` and `bin` are STRUCTURE — they say which channel
means what — and a view that restructured them would not be a view of the same
chart, it would be a different chart wearing its name. A `fn` override applies
to **every** measure, not just the first: a chart drawing three value series and
asked for "sum" means all three.

`topN: 0` is a real answer ("show every group"), not "unset", which is why the
delta compares against the resolved base rather than testing for falsiness.

### The word cloud's rules

`viz/word-frequency.ts` is pure and owns what counts as a word. Three of its
rules are user-settable, and one is subtler than it looks:

- **Ignore words shorter than N.** A blunt instrument — 3 suits prose.
- **Always keep these words.** The exception, and the reason it exists: acronyms
  are often the most interesting terms in a column and the first thing a length
  limit throws away (`AI`, `UI`, `CH`, `SQL`). It overrides the stop list and the
  numbers rule too, not just the length — "always keep this word" that a second
  rule could still eat would be a setting that lies.
- **Ignore these common words.** The stop list, as editable text. `resolveStopWords`
  distinguishes three states: **absent** ⇒ the built-in English list, **empty**
  ⇒ drop nothing (a real answer), and a list ⇒ that list. It also still accepts
  the boolean this option was before it became text, so templates saved then keep
  working.

## Exporting the numbers

A chart is a summary, and the summary is often the thing worth keeping — the word
counts, the totals per category. They exist nowhere else in the workspace, since
aggregation happens at draw time and is never stored. So a visualization window's
footer has a **CSV** button: `viz-panel.exportCsv()` picks the shape from the same
question the render asks (`spec.data` and the declared channel kinds), so the file
always matches what is on screen — terms and counts for a cloud, categories and
series for a chart, one row per point for a map.

`viz/viz-csv.ts` mirrors `plugins/csv-export.ts`'s dialect rather than importing
it: that is a plugin and this is core, and a core module importing a plugin would
invert the plugin model. A `null` point stays empty in the file rather than
becoming `0` — the frame distinguishes "no usable value" from zero, and
flattening it would put numbers in the file the chart never drew.

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
alongside `@marccawood/lit-dialogs` / `lit-menu` / `lit-toast`, so **nothing there
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

## Getting back to the configuration

A visualization's content IS a configuration — which kind, which columns on which
channels, which aggregate — so there has to be a route back to it from the thing
itself. There are two, because there are two different objects to edit:

- **`viz-footer.ts`** — the toolbar along the bottom of a visualization window.
  **Edit** opens the TEMPLATE (`openViewsDialog(tableId, { editTemplateId })`),
  where the kind, the aggregate and the options live and are shared by every
  instance of it; **Settings** opens THIS instance's mapping and overrides
  (`{ editInstanceId }`). An HTML view window still has no footer: it has
  nothing per-window to configure.

  The pair read the other way round until v0.0.370 — "Edit" the instance,
  "Chart" the definition — which put the shared object behind the more specific
  word. Someone looking for "the chart's settings" pressed Chart and edited what
  every other view of it also uses.
- The **docked pane's strip** carries the **Settings** pencil (the instance),
  because a pane has no footer of its own — the host window's footer belongs to
  the table — and a pane's likely edit is its own, not the shared definition.

`panel-footer` is deliberately not reused for this: it is per-TABLE and every one
of its buttons (add row, edit columns, export CSV) is about rows, which a
visualization does not own.

The `editInstanceId` / `editTemplateId` deep-links already existed on
`openViewsDialog`; the only change needed was that `editInstance` must take a viz
template's slots from its visualization's CHANNELS rather than from
`extractTokens` over HTML that is empty — the same split `useTemplate` makes.

## Word cloud sizing — why it is not just "count → font size"

`d3-cloud` **silently drops any word it cannot place**, which makes an over-large
font ceiling look like missing data rather than like a crowded cloud. Two things
follow, both in `elements/cloud-scale.ts` (in `elements/` because the element
needs it and everything there must be able to travel to a package):

- **Equal counts size at the MIDDLE of the range, not the top.** Ordinary prose
  gives almost every word a count of 1, as does any column of distinct names or
  tags. Sizing all of them at the maximum meant 53 terms rendered as 6 words. With
  no differences to show, size carries no information and must not shout.
- **`fitFontCeiling` derives the ceiling from the box AND the term count**,
  budgeting roughly equal area per term. A fixed `min(w,h)/5` was 93px for every
  one of those 53 terms.

The element then **retries smaller** while more than a tenth of the terms are
being dropped, keeps whichever pass placed more, and reports any remainder in the
corner. Rotation is hashed from the term text rather than `Math.random()`, so a
resize or a filter change re-lays out without reshuffling every word.

## Practical implications

- **A canvas has no readable content**, so every chart element renders a
  visually-hidden `<table class="a11y">` of the numbers beside it plus a
  `role="img"` summary. That is also what the e2e specs assert against — reading
  pixels would test Chart.js, not this app.
- **The map renders into the light DOM** (`createRenderRoot` returns `this`).
  Leaflet styles its panes with a global stylesheet; behind a shadow boundary that
  CSS does not reach it. Every other element keeps its shadow root.
- **…and having no shadow root of its own was not enough.** Up to v0.0.372 the
  stylesheet went into `document.head`, and the map is mounted inside
  `viz-panel`'s shadow root — where document styles do not apply. Every layer was
  built correctly (tiles and markers were in the DOM, the points were right) and
  then stacked in normal flow, because `.leaflet-pane { position: absolute }`
  never landed. Markers ended up outside the map container entirely.

  `adoptLeafletCss(root)` now puts the sheet in whichever root the element is
  actually in — the document in the light DOM, the host's shadow root otherwise —
  once per root via `adoptedStyleSheets`, with a `<style>` fallback. The lesson
  generalises: any third-party library that ships a global stylesheet needs the
  sheet in the element's own root, not in the document.
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

## The demo workspace is a test, not a document

`docs/help/workspace.db.json` is a dump a user can drop in to see every kind at
once (48 city trips: coordinates, dates, ratings and a sentence of prose each).
`test/e2e/114-viz-fixture.spec.ts` imports that exact file through the real drop
handler and asserts each kind draws, because a fixture that has drifted from the
code teaches a new user that the feature is broken.

It also covers a path nothing else does, and found a real bug doing so: a
`ViewDock` names its host by **table id**, and an import mints new ids — so a
docked pane arrived pointing at a table that no longer existed, was mounted
nowhere, and (docked instances being excluded from the window reconcile) vanished
entirely. `remapDock` in `plugins/json-import.ts` carries the host across for the
ordinary case, where the pane is docked into the window of the table it charts,
and DROPS the dock otherwise: visible in the wrong place beats invisible.
