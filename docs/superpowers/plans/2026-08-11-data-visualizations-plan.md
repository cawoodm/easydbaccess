# Visualizations — implementation plan

Companion to `docs/superpowers/specs/2026-08-11-data-visualizations-design.md`.
Read the spec first; this plan assumes its decisions.

Each phase is independently shippable and ends green (typecheck + lint + its
tests). Every commit bumps the patch version via the pre-commit hook — that is
expected; enable it in a fresh clone with
`git config core.hooksPath .githooks`. Prefer test-first wherever a pure
function or a clear contract exists.

The phase order is deliberate: **one whole vertical slice before any breadth.**
Phase 3 draws a real chart in a real window with only the bar kind, so the
contracts get exercised end-to-end before four more kinds are built on them.
Docking (phase 4) comes after, because it is the one phase that touches
`table-window-manager.ts` — the riskiest file in the change — and it should not
be carrying unproven contracts when it does.

## Phase 0 — Shared types (foundation)

**Files:** `packages/shared/src/types.ts`, `packages/shared/src/plugin-api.ts`,
`packages/shared/src/index.ts` (barrel).

- Add `VizSpec`, `VizAggregate`, `ViewDock` exactly as in the spec's "Data
  shapes". Add `kind?` and `viz?` to `ViewTemplate`, `dock?` to `ViewInstance`.
- Add `VizChannelSpec`, `VisualizationSpec`, and
  `UiRegistry.registerVisualization` to `plugin-api.ts`.
- **`exactOptionalPropertyTypes` is on:** every optional field needs an explicit
  `| undefined`. Don't paper over with `!`.
- Re-export the new types from the barrel.

**Verify:** `npm run typecheck` clean. Zero behaviour change.

**Do NOT touch** `dexie-db.ts`, `data-store-dexie.ts`, `data-store-ipc.ts` or
`sqlite-store.ts`. `viewTemplates`/`viewInstances` are `DOC_COLLECTIONS` and
every new field is non-indexed — if a change there feels necessary, the field
was modelled wrong.

## Phase 1 — The pure aggregator (test-first)

**Files:** `packages/renderer/src/viz/viz-aggregate.ts`,
`test/renderer/viz/viz-aggregate.test.ts`.

DOM-free, Dexie-free, no Lit. Export `VizFrame` and
`aggregateRows(rows, columns, mapping, spec)` per the spec.

**Write the tests first**, covering:

1. `groupBy` one channel, `count` → one category per distinct value, correct order.
2. `groupBy` two channels → categories are the cross-product actually present.
3. Each `fn`: `count`, `countDistinct`, `sum`, `avg`, `min`, `max`.
4. `topN: 3` over 10 groups → 3 groups + an "Other" that sums the tail.
5. Numeric `bin` with `width`, and date `bin` with each `unit`.
6. Empty `rows` → an empty frame, not a throw.
7. A `mapping` pointing at a field no column has → empty frame, no throw.
8. `null` / `''` group keys → their own category, labelled, not silently dropped.
9. A non-numeric value in a `sum` → skipped and counted, never coerced to 0.
10. `truncated` passes through from the caller's flag.
11. `groupBy: []` → exactly one category (the single-number case).

**Reuse, don't reinvent:** `@easydb/shared`'s `array-cell.ts` for reading an
`array` cell's members (a chart of a tags column should count per member, the way
the grid's filter already does), and `table/row-sort.ts`'s `compareValues` for
type-aware category ordering.

**Verify:** `npm run test` green for this file.

## Phase 2 — Registry + the visible-rows seam

**Files:** `packages/renderer/src/plugin-host/registries.ts`,
`packages/renderer/src/table/visible-rows.ts` (new),
`packages/renderer/src/table/data-table.ts`,
`test/renderer/table/visible-rows.test.ts`.

- `registries.ts`: add `visualizations: Map<string, VisualizationSpec>` and wire
  `registerVisualization` through the existing `mapReg` helper. Leave
  `rowRenderers` / `tableRenderers` untouched.
- `visible-rows.ts`: the `easydb:visible-rows` event, its detail type, an
  `emitVisibleRows(key, rows, total, truncated)` reporter, and **listener
  counting** so nothing is dispatched when no pane is watching. Model it on
  `db/settings-events.ts` — including the `typeof document === 'undefined'`
  guard — and on `table/table-loading.ts` for keeping state outside the
  component.
- `data-table.ts`: call the reporter from `emitCount()`, which already runs after
  every render and already has the key (`viewInstanceId || tableId`) and the
  filtered set. **Match its change-detection**: `emitCount` only dispatches when
  the numbers actually changed; do the same rather than emitting an array on
  every render.

**Test:** listener counting (no listeners ⇒ no dispatch), and that the reporter
is a no-op without a `document`. The `data-table` side is e2e territory.

**Verify:** `npm run test` + `npm run typecheck` green. No user-visible change.

## Phase 3 — First vertical slice: `viz-panel` + `viz-bar`, windowed only

**Files:** `packages/renderer/src/viz/viz-panel.ts`, `viz-theme.ts`,
`packages/renderer/src/plugins/viz-bar.ts`,
`packages/renderer/src/plugin-host/loader.ts`,
`packages/renderer/src/dialogs/views-dialog.ts`,
`packages/renderer/src/window-mgr/view-window-manager.ts`,
`packages/renderer/package.json`.

- `viz-panel.ts` — the Lit host. Resolves `VizSpec.kind` against
  `registries.visualizations`, obtains rows (subscribe to `easydb:visible-rows`
  when docked; else `readRows` + `coll.watch ?? coll.subscribe`, copying
  `view-window.ts`'s `loadRows`), runs `aggregateRows`, and mounts the registered
  element via `unsafeStatic`/`staticHtml` — the same runtime-tag-name technique
  `data-table.ts`'s `renderCell()` uses. Renders the truncation note from
  `db/truncation-note.ts`, the `role="img"` + `aria-label`, and the hidden
  numbers table.
- `viz-bar.ts` — a built-in registering `{ id: 'bar', tag: 'viz-bar', channels:
  [CATEGORY, VALUE], data: 'aggregate' }`. It owns channels, mapping and
  aggregation, and hands the element a neutral shape.
- `viz/elements/bar-chart.ts` — the element. `await import('chart.js')` on first
  update; `ResizeObserver` → `chart.resize()`; colours read from CSS custom
  properties via `viz-theme.ts`.
  **It must not import `@easydb/shared`** — no `Row`, `ColumnSpec`, `VizFrame` or
  `HostApi`. It declares its own `{ categories: string[]; series: {label, points}[] }`
  input, because this file is destined for `@cawoodm/lit-charts` (see the spec's
  packages section). Keep every element under `viz/elements/` for exactly that
  reason, and export a guarded `defineBarChart()` rather than using
  `@customElement`, matching `lit-dialogs`' `defineHostDialogs()`.
  A lint check that nothing under `viz/elements/` imports `@easydb/shared` is
  worth more than the convention being written down.
- `views-dialog.ts` — the kind switch, the viz picker, channel mapping (reusing
  the token-mapping UI over the same `mapping` record), and the options editor
  over `SettingsFieldSpec`.
- `view-window-manager.ts` — a `kind === 'viz'` instance mounts `<viz-panel>`
  instead of `<view-window>`. **Keep the lazy mount/unmount** — a viz holds a
  chart instance and a row subscription, so minimize must drop it exactly as it
  drops a grid.

**Verify:** `npm run typecheck && npm run lint && npm run test`, then drive it by
hand: `npm run dev:renderer`, import a CSV, create a bar visualisation, confirm
it draws, filters with the view's own filters, and survives a reload. Confirm
`chart.js` is in a lazily-loaded chunk (`npm run build`, check the chunk list) and
**not** in the entry bundle.

## Phase 4 — Docking

**Files:** `packages/renderer/src/window-mgr/panel-stack.ts` (new),
`packages/renderer/src/window-mgr/geometry-math.ts` or a new
`window-mgr/stack-math.ts`, `table-window-manager.ts`,
`view-window-manager.ts`, `packages/renderer/src/viz/viz-pane.ts` (new).

- **Extract the splitter arithmetic into a pure module and unit-test it**
  (clamping a pane between a minimum and the available height, redistributing on
  container resize). That is the `window-mgr/geometry.ts` /
  `panel-shell/geometry-math.ts` pattern — the decision is testable even though
  the drag is not.
- `panel-stack.ts` — `[above…][primary][below…]`, `flex-direction: column`,
  primary `flex: 1`, panes at fixed px. **A stack with no panes must render its
  primary child exactly as before**; assert that with an e2e regression check on
  an ordinary table window.
- Both managers wrap `content` in a stack. `mountContent`/`unmountContent`
  build/tear down the stack, so minimize still drops every pane.
- Splitter drag end → `ViewDock.size` via `queueGeometryWrite()` (keyed
  `view:<id>`, matching the existing key convention).
- `viz-pane.ts` — the pane strip: title, collapse, undock, close. Undock clears
  `dock`; the same reconciler then opens a window.
- Extend `view-window-manager.ts`'s existing `viewInstances.subscribe()`:
  `open && !dock` → panel, `open && dock` → mount into the host stack. **One
  reconciler.** A host panel that isn't open yet must not strand the pane —
  reconcile again when the host opens.

**Verify:** `npm run test` (stack math), `npm run test:e2e` for
`105-viz-docking.spec.ts`: dock a pane, filter the grid and watch the numbers
change, drag the splitter and reload to assert persistence, minimize and assert
the pane unmounted, undock and assert a window opens.

## Phase 5 — `line` + `pie`

**Files:** `packages/renderer/src/plugins/viz-line.ts`, `viz-pie.ts`, loader.

Both reuse phase 3's panel and phase 1's aggregator unchanged — if either needs a
change to the aggregator or the host, that is a signal the phase-3 contracts were
wrong and worth fixing rather than working around. `line` adds the `time`
channel and date binning; `pie` declares `topN` in its `defaultAggregate` (a pie
with 40 slices is unreadable).

**Verify:** typecheck + lint + the e2e spec extended with one case per kind.

## Phase 6 — `map`

**Files:** `packages/renderer/src/plugins/viz-map.ts`,
`packages/renderer/src/viz/viz-settings.ts` (new),
`packages/renderer/src/plugins/settings.ts`.

- `viz-settings.ts` — the settings namespace (tile URL template, marker style),
  copied in shape from `table/grid-settings.ts` **for the dependency reason that
  file states**: the `settings` plugin registers the fields, the element reads
  them, neither imports the other. Re-read on `easydb:settings-changed`.
- `viz-map.ts` — `data: 'rows'` (points, not groups), `LAT`/`LON` channels plus
  optional `WEIGHT` and `TEXT`. Lazy `import('leaflet')`; Leaflet's CSS imported
  alongside it.
- **The offline path is a requirement, not a nicety:** on tile error, draw the
  markers on a plain background with a one-line notice. Test it by pointing the
  tile setting at an unreachable host.

**Verify:** manual (tiles need network), plus an e2e that asserts markers render
with the tile URL pointed at a dead host — that is the case most likely to
regress and the one a CI box can actually check.

## Phase 7 — `wordcloud`

**Files:** `packages/renderer/src/plugins/viz-wordcloud.ts`,
`packages/renderer/src/viz/word-frequency.ts` (new, pure),
`test/renderer/viz/word-frequency.test.ts`.

- Tokenisation and frequency counting go in the **pure** module: lower-casing,
  splitting, a stop-word list, a minimum length, a maximum term count. That is
  the part with judgement in it, so it is the part that gets unit tests.
- `d3-cloud` computes the layout; we render its output into our own SVG so
  styling stays in-house and themable.
- The layout is O(terms × placement attempts) and runs on the main thread — cap
  the term count and bail out with a note rather than hanging a window.

**Verify:** `npm run test` for the frequency module; e2e that a cloud renders.

## Phase 8 — The rename fix

**Files:** `packages/renderer/src/table/table-references.ts`,
`packages/renderer/src/dialogs/new-table-dialog.ts`,
`test/renderer/table/table-references.test.ts` (existing suite — extend it).

Add `renameViewMappings(instance, renames)` beside `renameProjectionOutputs` /
`renameProjectionSourceFields` and call it from the same `submit`. Pure, so
unit-test it directly alongside the projection rename cases already there.
**This fixes HTML views too** — a renamed token silently empties today — so cover
both in the test.

Independent of every other phase; land it whenever, including first.

## Phase 9 — Extract the three element packages

**New repos:** `cawoodm/lit-charts`, `cawoodm/lit-map`, `cawoodm/lit-wordcloud`.
**Files:** everything under `packages/renderer/src/viz/elements/` moves out;
`packages/renderer/package.json` gains the three SHA pins.

Only worth doing once phases 3–7 have settled the element inputs. Per package,
copy the manifest shape from `@cawoodm/lit-dialogs` exactly — and note that
`node_modules/@cawoodm/lit-dialogs` ships its `src/` as well as `dist/`, so it can
be read as the reference implementation without cloning anything:

- zero `dependencies`; `lit` **and** the drawing library (`chart.js` / `leaflet` /
  `d3-cloud`) both as `peerDependencies`;
- `"prepare": "npm run build"` — mandatory for a `github:` install to have a
  `dist/`;
- `"sideEffects": false` + guarded `defineX()` exports, never `@customElement`;
- flat `src/` → `dist/` via plain `tsc`, barrel `index.ts`,
  `exports: { ".": "./dist/index.js" }`,
  `files: [dist, src, README.md, LICENSE]`, MIT, `engines.node >= 20`.

Then pin each in `packages/renderer/package.json` as
`github:cawoodm/lit-charts#<sha>` and delete the local copies. `npm install`,
full gate, and confirm the lazy chunking still holds — a package boundary is
where a static import most easily sneaks back in.

**Verify:** `npm run typecheck && npm run lint && npm run test && npm run test:e2e
&& npm run build`, plus a check that the chart chunk is still separate from the
entry bundle.

## Phase 10 — Docs and ship

- `docs/tech/VISUALIZATIONS.md` in the house voice (what it is, the channel
  model, where rows come from, the docking stack, what is deliberately not
  wired). Link it from `docs/tech/INDEX.md`; add the plugin rows to
  `PLUGINS.md`'s roster table; add the stack to `WINDOWS.md`; add a
  `docs/help/` page with screenshots.
- Full gate: `npm run typecheck && npm run lint && npm run test &&
  npm run test:e2e && npm run build`.
- Publish a branch preview (`npm run publish -- -Target easydbaccess<N>` — needs
  `pwsh`; if absent, build with `--base /easydbaccess<N>/` and deploy the output
  to the Pages repo by hand) and put the URL on the first line of the PR body,
  per the repo convention.

## Risks / watch-items

- **`table-window-manager.ts` is the risky file.** Every table window in the app
  goes through it. The mitigation is that an empty stack must be behaviourally
  identical to today — pin that with an e2e check on a plain table window, not
  just by reading the diff.
- **Publishing rows on every render.** `emitCount()`'s change-detection is the
  model; without it a docked pane makes every keystroke in a filter box copy the
  row set. Listener counting is the second guard.
- **Aggregating a scripted column** must happen after script evaluation, not
  before. `view-window.ts`'s `recompute()` ordering is the reference.
- **Row caps are a correctness issue, not a performance one.** A chart over the
  first 20,000 of 600,000 rows looks exactly like a chart over all of them.
  The truncation note is not optional polish.
- **The extraction constraint is the thing to hold, not the file layout.**
  Elements are built in-repo and extracted in phase 9, so the only rule that has
  to survive from phase 3 is that nothing under `viz/elements/` imports
  `@easydb/shared`. Moving files later is cheap; discovering at phase 9 that every
  element reaches into `Row` is not. Enforce it with a lint rule on day one.
- **`prepare` and guarded `define` are the two ways a `github:`-pinned package
  fails quietly.** No `prepare` ⇒ no `dist/` ⇒ unresolvable `main`. An
  `@customElement` decorator ⇒ a second define of the same tag throws on a
  double-load, which is why `lit-dialogs` hand-rolls a guarded `defineHostDialogs()`.
- **Bundle size.** Verify after phase 3 that the chart chunk is genuinely lazy;
  a static import sneaking in would put Chart.js in the entry bundle for users
  who never open a chart.
