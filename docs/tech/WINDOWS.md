# Windows

How table and view panels are drawn, dragged, resized, minimized, maximized,
and restored across reloads. This is entirely **core** code
(`packages/renderer/src/window-mgr/`), not plugin code — plugins request a
table or a view be shown; they never touch a panel instance directly. See
[`PLUGINS.md`](./PLUGINS.md) for how the `views` plugin's dialog and the
core view-window manager divide responsibility, and [`STORAGE.md`](./STORAGE.md)
for where `WindowGeometry` is persisted (`Table.windowGeometry` /
`ViewInstance.windowGeometry`).

## Two window managers, one shared panel shell

There are two independent, structurally identical managers:

- **`table-window-manager.ts`** — one floating window per `Table` in the current
  workspace, holding a live `<data-table>`.
- **`view-window-manager.ts`** — one floating window per open `ViewInstance`
  (see `PLUGINS.md`'s Views section), holding a read-only `<view-window>`.

Both create their windows through `createPanel()` in the in-repo
[`window-mgr/panel-shell/panel-shell.ts`](../../packages/renderer/src/window-mgr/panel-shell/panel-shell.ts).
This replaced the third-party [jsPanel4](https://jspanel.de/) library — the
app no longer depends on it, and no code imports it. The shell keeps jsPanel's
old DOM shape and class names on purpose (`.jsPanel`, `.jsPanel-hdr`,
`.jsPanel-headerlogo`, `.jsPanel-replacement`, …) so the existing CSS in
`index.html` and the existing e2e specs did not need to change; a panel
element also still doubles as its own handle (`document.getElementById(id).minimize()`
works), matching jsPanel's API shape. Everything about *how* a panel behaves —
minimize, maximize, smallify, drag, resize, close, front — is now first-party
code, not a vendored library.

Each manager runs a workspace-scoped `subscribe()` on its Dexie-backed
collection that reconciles "what should be open" against "what is currently
open" — opening panels for new/flagged records, closing panels for deleted
ones — and every geometry-affecting callback (`onmoved`, `onresized`,
`onstatuschange`) writes straight back to that record's `windowGeometry`.
Several small modules are shared between the two managers:

- `panzoom.ts` — the canvas pan/zoom transform (see below).
- `panel-title.ts` — the "`Name (12)`" / "`Name (3/12)`" row-count suffix,
  driven by a `document`-level custom event so the title bar doesn't need a
  direct reference to the grid inside it.
- `front-order.ts` — one monotonic front-rank counter shared by both kinds,
  so a table fronted a moment before a view (or vice versa) still compares
  correctly against it (see Z-order below).
- `geometry-writes.ts` — serializes the read-modify-write races between a
  panel's own callbacks (see Z-order below).
- `panel-registry.ts` / `restack.ts` — the cross-kind restack (see Z-order
  below).

## Table windows (`table-window-manager.ts`)

**Boot restore.** On `initWindowManager()`, every table in the current
workspace is loaded and opened in **ascending saved-`z` order** — so the
panel shell's z-index counter re-creates the panels in the same relative
order they were last stacked, and the panel that was on top last session
ends up on top again. A live `tables.subscribe()` then keeps this
reconciled afterward: a table appearing (import, another device's sync
pull) opens a panel; a table disappearing closes one.

**Geometry.** `WindowGeometry` is `{ x, y, w, h, z, minimized, maximized }`.
On restore, `sanitizeGeometry()` (a pure function in its own
`window-mgr/geometry.ts`, unit-tested in isolation from the DOM) discards
only _corrupt_ records (missing, non-finite, or smaller than `200×100`) and
the caller falls back to a cascading
default position + a `720×360` content size — position itself is **never
clamped to the viewport**, because a panel legitimately restoring off-screen
is recoverable via the pan/zoom canvas (see below), and clamping would
fight a user who deliberately parked a window there. Dragging and resizing
both ignore any containment box for the same reason. Every drag/resize stop
and every status change (minimize/maximize/normalize) calls
`saveGeometry()`, which reads the panel's live `offsetLeft/Top/Width/Height`
— **except** while minimized or maximized, where the shell's own layout
(`display: none`, or filling the container) doesn't describe the panel's
"normal" rect, so the previous stored rect is kept and only the
`minimized`/`maximized` flags flip.

**`?minimize` — open everything minimized.** A rescue hatch for a workspace
whose tables are too big to load: `http://localhost:5190/?minimize` (any
truthy value, or the bare flag; `?minimize=0` is off) opens **every** table
minimized regardless of its saved geometry. This works because a minimized
panel mounts a bare placeholder instead of a `<data-table>` — it holds no rows,
keeps no store subscription, and a live/remote table fetches nothing until it
is expanded. So the workspace opens instantly and the user can expand one table
at a time (or delete the one that is too big) via the titlebar or Ctrl+K →
"Go to &lt;table&gt;", which normalizes a minimized panel.

The flag is a **view override, not a saved preference.** While it is on,
`saveGeometry()` keeps the stored `minimized`/`maximized` flags instead of
writing the live status — otherwise a single visit would leave every table
minimized on every later visit, and expanding one table to look at it would
silently rewrite the saved layout. The flag (`FORCE_MINIMIZED` in
`boot-flags.ts`) is read once at module load, so editing the query string
mid-session cannot retroactively change how already-open panels behave.

**`?minimize` only forces table windows.** View windows now support the
same lazy mount/unmount as tables — minimizing a view window manually
detaches its `<view-window>` and drops its row subscription, exactly like a
table (see "View windows", below) — but `view-window-manager.ts` doesn't
read `FORCE_MINIMIZED`, so the boot-time flag itself doesn't touch already-open
views. A workspace with `?minimize` still opens its views at their normal cost.

**Z-order.** A panel's DOM `z-index` is session-local: the shell's own
counter (`nextZ()` in `panel-shell.ts`) only ever increases while the app is
open, but it is never persisted and resets on every reload. So `onfronted`
instead stamps `windowGeometry.z` with a monotonic front-rank counter
(`nextFrontZ()` in `front-order.ts`) — not a DOM value — and boot restore
just sorts ascending by that number. Higher (more recent) = fronted later =
ends up on top. It's _not_ plain `Date.now()`: two panels fronted within the
same millisecond used to tie and lose their relative order; a `+ 1` fallback
guarantees every stamp is strictly greater than the last regardless of
wall-clock resolution. (This replaced jsPanel's `front()`, which called an
internal `resetZi()` on every front, renormalizing every panel to a
contiguous range — so the just-fronted panel always read back the same "max"
DOM value and gave no stable ordering to persist.)

A bulk restore can also need to re-establish z-order **after** boot — a
gist Pull inserts tables one at a time (each a separate `liveQuery` write),
so panels open in file order, not saved-z order — and the two managers open
in a fixed sequence at plain boot (every table, then every view), which
also defeats a saved order where a view was on top of a table. `restack.ts`
is the one place both kinds are merged and re-fronted together: it runs once
right after both managers finish their initial open, and again whenever
`gist-sync.ts` / `json-import.ts` dispatch an `easydb:restack-windows`
document event after a bulk pull/import. Both cases end up in the same
`restackAll()`, which merges open tables and open views into one candidate
list, sorts by the shared `front-order.ts` rank, and fronts each in turn —
skipped entirely under `?minimize`, since fronting would un-park a
deliberately-minimized panel.

**Minimize unmounts the grid.** A `<data-table>` holds every row in memory,
keeps a live store subscription open, and — for a source-routed table (see
`STORAGE.md`'s row-source section) — fetches rows the instant it mounts. So
a minimized window doesn't just visually collapse: the status-change handler
detaches the `<data-table>` entirely (`unmountContent`) and replaces it with
a bare placeholder, releasing memory and stopping any polling; expanding it
again (`mountContent`) mounts a fresh grid that re-subscribes and re-fetches
from scratch. A window that restores already minimized on boot never mounts
a grid until the user expands it.

**Maximize interacts with the pan/zoom canvas.** See "Maximize while panned
or zoomed" below — table windows and view windows share the exact same
re-fit logic, built into the panel shell itself.

**Closing hides the table, it doesn't delete it.** `close()` on the panel is
a plain synchronous call — there is no confirm dialog in the close path
itself. `onclosed` fires right after and just marks the table's
`windowGeometry` as `closed: true`, keeping its data; the table reopens from
the command palette ("Go to &lt;table&gt;"). Actually deleting a table's data
is a separate, explicit action: the delete-table plugin's own button, which
asks WHICH delete is meant — all the rows, the rows a filter left visible, or
the table itself (see `DATA-TABLE.md` § "Three deletes, one button"). A table
removed _externally_ (a JSON "replace entire
workspace" import, a server/gist pull) is tracked in a separate
`externallyClosed` set so the reconciling subscription's forced close skips
re-marking a record whose data is already gone.

**Titlebar text is `Table.title || Table.name`**, via a small `displayName()`
helper — a table may carry an optional display `title` (edited in the
column editor) shown in the panel instead of its technical `name`; exports,
filenames, and every other reference still use `name`. Same split as
`Workspace.title`/`name` in the header (see `STORAGE.md`, `DIALOGS.md`).

**Chrome additions beyond the panel shell's defaults:** a per-table
`<panel-search>` box and an info (`ⓘ`) button are prepended into the panel's
own controlbar (next to minimize/maximize/close); a `<panel-footer>` (icon
toolbar — CSV export/import, column editor, etc. — see `PLUGINS.md`) is
passed as `footerToolbar`. The titlebar is made programmatically focusable
(`tabIndex=-1` + a `pointerdown` listener) purely so clicking it can blur
whatever search box currently has focus, collapsing it.

## View windows (`view-window-manager.ts`)

Structurally the same manager, driven by `ViewInstance.open` instead of the
table set itself: the reconciling subscription opens a window for every
instance where `open === true` and closes one the moment that flag drops or
the instance is deleted. Closing the window (user click, not a data change)
writes `open: false` back so it doesn't reopen on the next boot — the panel
shell itself has no cross-reload memory of its own, exactly like table
windows.

Like table windows, a view window mounts its content (`<view-window>`)
lazily: one that opens minimized gets a bare placeholder, and minimizing an
open one later detaches the element and drops its row subscription. The one
difference from table windows is the boot-time `?minimize` flag, which only
table windows honor (see above).

Two behaviors are unique to view windows:

- **Reconnect-by-name.** A view is bound to a table by `tableId`, but
  deleting a table and recreating it under the same name mints a fresh id,
  orphaning the view. A `tables.subscribe()` runs
  `reconnectDanglingViews()` on every table write: any view instance whose
  `tableId` no longer resolves, but whose snapshotted `tableName` matches a
  live table in the same workspace, gets silently rebound to that table's
  new id.
- **Live template/instance edits.** Two custom events —
  `easydb:reload-view` (one instance renamed/remapped) and
  `easydb:reload-views` (a shared template edited, potentially affecting
  several open instances) — let the Views dialog push an edit into an
  already-open window without tearing it down and reopening it.

View panels use a distinct chrome color (`color: '#0891b2'`, cyan) purely so
they read visually as different from table windows.

## Docked panes — the content stack

`createPanel()` takes a single `content` element, so both managers now wrap their
content in a **`panel-stack.ts`**: `[panes above][primary][panes below]`, with a
drag splitter per pane. A docked visualization (`ViewInstance.dock`) is mounted
into a host panel's stack instead of getting a window of its own — see
[`VISUALIZATIONS.md`](./VISUALIZATIONS.md).

**With no panes the stack renders its primary child and nothing else** — one flex
wrapper, no listeners, no layout of its own — so every window that has nothing
docked behaves exactly as it did before. That is the property the design rests
on, and it is pinned by an e2e check on a plain table window rather than left to
inspection.

Three consequences for this file's concerns:

- **Minimize still drops everything.** `mountContent` / `unmountContent` build and
  tear down the *stack*, so a minimized window holds neither its grid nor any
  pane, and neither holds a subscription.
- **Maximize needs no new code.** The stack is `flex-direction: column` with the
  primary at `flex: 1`, so a maximized panel just gives the primary more room;
  the shell's counter-transform for the pan/zoom canvas is untouched.
- **Splitter releases persist `ViewDock.size`** through the same
  `queueGeometryWrite()` every other geometry write uses — on release, not per
  pointermove, which would queue a store write per pixel. The clamping
  arithmetic is pure and unit-tested in `stack-math.ts`.

`panel-stacks.ts` is the registry that lets `view-window-manager.ts` find a table
window's stack without importing `table-window-manager.ts` — the same decoupling
`panel-registry.ts` (restack) and `shell-viewport.ts` (pan/zoom) already exist
for. It notifies on change, because a host panel appearing is not a store change
and a pane whose host opened second would otherwise never mount.

## The pan/zoom canvas (`panzoom.ts`)

Both window managers render into `#easydb-panels-viewport`, an inner element
inside the fixed `#easydb-panels` overlay that `panzoom.ts` drives a CSS
`translate()/scale()` on. This exists because panel dragging is
**deliberately unclamped** (see above) — a panel can end up fully
off-screen — and the pan/zoom canvas is how you get it back:

- **Touch:** one finger on empty canvas background pans; two fingers
  anywhere pinch-zooms (keeping the world point under the pinch midpoint
  fixed, so it doesn't drift); double-tap resets to 1:1. A touch that starts
  on a panel is left alone so the grid still scrolls and cells still
  respond to taps.
- **Desktop:** right-button drag anywhere over the canvas pans it (a
  `mousemove`/`mouseup` pair attached at `window` level in the capture
  phase, since the overlay itself is `pointer-events: none` on desktop so
  left-clicks fall through to the panel's own dragging). A plain right-click
  with no movement still opens the context menu — only a drag that actually
  moved past a small threshold suppresses it.

Panel geometry is always stored in the viewport's own **untransformed**
layout coordinates, so the panel shell's internal drag/resize math never has
to know about the canvas transform — only the maximize re-fit below cares
about it. Scale is clamped to `[0.25, 4]`.

## Maximize while panned or zoomed

The panel shell sizes a maximized panel to fill its **container's layout
box** (`left:0, top:0`, `clientWidth × clientHeight`) — correct in layout
terms, but since the container itself is scaled/translated by the canvas
transform, a maximized window would visually drift or scale along with
whatever pan/zoom state happened to be active. `createPanel()` gives every
maximized panel its own counter-transform that exactly cancels the canvas's:
for a canvas `translate(tx, ty) scale(s)`, the panel gets
`translate(-tx/s, -ty/s) scale(1/s)`, which maps the panel's `(0,0)-(W,H)`
box back onto the overlay's `(0,0)-(W,H)` regardless of how the canvas is
currently panned or zoomed. It subscribes to the shared pan/zoom state for
the duration of the maximized state (`enterMaximized()`/`exitMaximized()`,
both idempotent) so panning or zooming _while_ a window is maximized keeps
it filling the screen instead of sliding out from under itself, and it
attaches a `ResizeObserver` on the container so a maximized panel also
re-fits on a plain browser resize or header wrap, with no pan/zoom
involved. Table and view windows share the exact same code path inside
`panel-shell.ts` and the exact same live pan/zoom state (exposed via
`shellViewport()`/`currentPanZoom()` in `shell-viewport.ts` — a module of its
own so that a plugin opening a panel does not have to import a window manager
to learn the current zoom; the table manager sets the handle, and the
view-window manager, initialized separately, reuses it).

**Restore-from-dock returns to maximized, if that's where it was minimized
from.** The shell's status machine (`panel-shell/state.ts`) remembers
`restoreStatus` across a minimize: minimizing a maximized window and then
restoring it from the dock lands back on maximized, not merely normalized.
`persistFlags()` keeps `maximized: true` in that case too, so the same
behavior survives a reload (pinned by the `08-window-manager` e2e spec).

## The titlebar colour, and overriding it

A panel's colour is computed from what the window IS: `panelColor(table)` gives
every table a shade of blue by kind (`table-kind.ts`), a view is teal and a
visualization violet (`view-window-manager.ts`). The shell paints the window AND
its minimized dock bar from the one `--eda-panel-color` value, so a docked window
keeps its colour.

On top of that, each window can carry a colour the USER picked, from the palette
button both managers prepend to `.jsPanel-controlbar`
(`color-button.ts` builds it, `window-color.ts` holds the list and the storage).
Three things worth knowing:

- **The override wins, and clearing it restores the KIND colour** — not a stored
  "normal". So a table that gains a `source` while its window is open still takes
  its new kind colour, unless the user has chosen one. Both managers repaint
  through one function (`paintChrome` in the table manager) for that reason.
- **It is a `settings` key, `window-color:<id>`, not a field on the record.** It
  needs no change to the stored shape of a table, and a settings key is reachable
  by a plugin — which the titlebar is not, since there is no registry for a
  titlebar button. Keyed by TABLE id for a table window and by VIEW INSTANCE id
  for a view, so two views of one table colour independently.
- **The picker is a hand-rolled popover, not `AnchoredMenu`.** The shared menu
  renders its `icon` as a Material ligature in one colour, so a swatch handed to
  it comes out as literal `<svg …>` text. It is still a native `popover="auto"`,
  so the browser owns the top layer and the light dismiss.

## Practical implications

- **A panel's on-screen position is not its "real" position while minimized
  or maximized.** Both `saveGeometry` functions special-case those two
  states and reuse the last normalized rect rather than reading
  `offsetLeft`/`offsetTop`, which would otherwise persist the `display: none`
  minimize state or the maximized full-container size as if it were the
  user's intended layout.
- **Z-order is a timestamp, not a DOM read.** Anything that needs "is this
  panel on top" has to go through the persisted `windowGeometry.z`
  (`onfronted` → `stampFrontOrder`/`stampViewFrontOrder`) — reading the
  panel's live `style.zIndex` directly would see a session-local value that
  resets on reload, not a stable per-panel ordering.
- **Off-screen geometry is a feature, not a bug to guard against.** Don't
  "fix" a window that restores partially or fully outside the viewport —
  that's expected, and the pan/zoom canvas (or a double-tap reset on touch)
  is the intended way back, not a geometry clamp.
