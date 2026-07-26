# Windows

How table and view panels are drawn, dragged, resized, minimized, maximized,
and restored across reloads. This is entirely **core** code
(`packages/renderer/src/window-mgr/`), not plugin code — plugins request a
table or a view be shown; they never touch a jsPanel instance directly. See
[`PLUGINS.md`](./PLUGINS.md) for how the `views` plugin's dialog and the
core view-window manager divide responsibility, and [`STORAGE.md`](./STORAGE.md)
for where `WindowGeometry` is persisted (`Table.windowGeometry` /
`ViewInstance.windowGeometry`).

## Two window managers, one shared plumbing

There are two independent, structurally identical managers:

- **`jspanel-manager.ts`** — one floating window per `Table` in the current
  workspace, holding a live `<data-table>`.
- **`view-window-manager.ts`** — one floating window per open `ViewInstance`
  (see `PLUGINS.md`'s Views section), holding a read-only `<view-window>`.

Both are built on [jsPanel4](https://jspanel.de/) and follow the same
pattern: a workspace-scoped `subscribe()` on the relevant Dexie-backed
collection reconciles "what should be open" against "what is currently
open" — opening panels for new/flagged records, closing panels for deleted
ones — and every geometry-affecting jsPanel callback (`dragit.stop`,
`resizeit.stop`, `onstatuschange`) writes straight back to that record's
`windowGeometry`. Three small modules are shared between them:
`maximize-fill.ts` (keep a maximized panel filling the screen despite canvas
pan/zoom), `panzoom.ts` (the canvas transform itself), and `panel-title.ts`
(the "`Name (12)`" / "`Name (3/12)`" row-count suffix, driven by a
`document`-level custom event so the title bar doesn't need a direct
reference to the grid inside it).

## Table windows (`jspanel-manager.ts`)

**Boot restore.** On `initWindowManager()`, every table in the current
workspace is loaded and opened in **ascending saved-`z` order** — so
jsPanel's own internal z-index counter re-creates the panels in the same
order they were last stacked, and the panel that was on top last session
ends up on top again. A live `tables.subscribe()` then keeps this
reconciled afterward: a table appearing (import, another device's sync
pull) opens a panel; a table disappearing closes one.

**Geometry.** `WindowGeometry` is `{ x, y, w, h, z, minimized, maximized }`.
On restore, `sanitizeGeometry()` (a pure function in its own
`window-mgr/geometry.ts`, unit-tested in isolation from jsPanel/DOM) discards
only *corrupt* records (missing, non-finite, or smaller than `200×100`) and
the caller falls back to a cascading
default position + a `720×360` content size — position itself is **never
clamped to the viewport**, because a panel legitimately restoring off-screen
is recoverable via the pan/zoom canvas (see below), and clamping would
fight a user who deliberately parked a window there. `dragit`/`resizeit`
both set `containment: false` for the same reason. Every drag/resize stop
and every `onstatuschange` (minimize/maximize/normalize) calls
`saveGeometry()`, which reads the panel's live `offsetLeft/Top/Width/Height`
— **except** while minimized or maximized, where jsPanel's own layout
(parked off-screen at `left:-9999`, or filling the container) doesn't
describe the panel's "normal" rect, so the previous stored rect is kept and
only the `minimized`/`maximized` flags flip.

**Z-order.** jsPanel has no stable, readable z-index: `front()` calls
`resetZi()` internally, renormalizing every panel to a contiguous range each
time, so the just-fronted panel always reads back the same "max" value.
Instead, `onfronted` stamps `windowGeometry.z` with `Date.now()` — a wall
clock timestamp, not a DOM value — and boot restore just sorts ascending by
that timestamp. Higher (more recent) = fronted later = ends up on top.

**Minimize unmounts the grid.** A `<data-table>` holds every row in memory,
keeps a live store subscription open, and — for a source-routed table (see
`STORAGE.md`'s row-source section) — fetches rows the instant it mounts. So
a minimized window doesn't just visually collapse: `onstatuschange` detaches
the `<data-table>` entirely (`unmountContent`) and replaces it with a bare
placeholder, releasing memory and stopping any polling; expanding it again
(`mountContent`) mounts a fresh grid that re-subscribes and re-fetches from
scratch. A window that restores already minimized on boot never mounts a
grid until the user expands it.

**Maximize interacts with the pan/zoom canvas.** See "Maximize while panned
or zoomed" below — table windows and view windows share the exact same
`createMaximizeFill()` helper for this.

**Closing asks first, twice.** jsPanel's `onbeforeclose` hook can't `await`
a confirm dialog — it must return synchronously. The workaround is a
two-step dance: the first close attempt opens the async confirm dialog and
returns `false` (cancelling that close); if the user confirms, the table id
is added to a `confirmedClose` set and `panel.close()` is called again,
which this time short-circuits straight through. `onclosed` then cascades:
it deletes the `Table` record and (for a plain local table — **not** one
carrying a `source`, since its rows live on the remote and must not be
issued a bulk-delete) removes all of its rows too. A table removed
*externally* (a JSON "replace entire workspace" import, a server/gist pull)
is tracked in a separate `externallyClosed` set so the reconciling
subscription's forced close skips that redundant cascade — the data is
already gone.

**Titlebar text is `Table.title || Table.name`**, via a small `displayName()`
helper — a table may carry an optional display `title` (edited in the
column editor) shown in the panel instead of its technical `name`; exports,
filenames, and every other reference still use `name`. Same split as
`Workspace.title`/`name` in the header (see `STORAGE.md`, `DIALOGS.md`).

**Chrome additions beyond jsPanel's defaults:** a per-table `<panel-search>`
box and an info (`ⓘ`) button are prepended into jsPanel's own controlbar
(next to minimize/maximize/close); a `<panel-footer>` (icon toolbar — CSV
export/import, column editor, etc. — see `PLUGINS.md`) is passed as
`footerToolbar`. The titlebar is made programmatically focusable
(`tabIndex=-1` + a `pointerdown` listener) purely so clicking it can blur
whatever search box currently has focus, collapsing it.

## View windows (`view-window-manager.ts`)

Structurally the same manager, driven by `ViewInstance.open` instead of the
table set itself: the reconciling subscription opens a window for every
instance where `open === true` and closes one the moment that flag drops or
the instance is deleted. Closing the window (user click, not a data change)
writes `open: false` back so it doesn't reopen on the next boot — jsPanel
itself has no cross-reload memory, exactly like table windows.

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

View panels use a distinct chrome color (`theme: '#0891b2'`, cyan) purely so
they read visually as different from table windows.

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
  left-clicks fall through to jsPanel's own dragging). A plain right-click
  with no movement still opens the context menu — only a drag that actually
  moved past a small threshold suppresses it.

Panel geometry is always stored in the viewport's own **untransformed**
layout coordinates, so jsPanel's internal drag/resize math never has to
know about the canvas transform — only the maximize-fill counter-transform
below cares about it. Scale is clamped to `[0.25, 4]`.

## Maximize while panned or zoomed (`maximize-fill.ts`)

jsPanel sizes a maximized panel to fill its **container's layout box**
(`left:0, top:0`, `clientWidth × clientHeight`) — correct in layout terms,
but since the container itself is scaled/translated by the canvas
transform, a maximized window would visually drift or scale along with
whatever pan/zoom state happened to be active. `createMaximizeFill()` gives
the maximized panel its own counter-transform that exactly cancels the
canvas's: for a canvas `translate(tx, ty) scale(s)`, the panel gets
`translate(-tx/s, -ty/s) scale(1/s)`, which maps the panel's `(0,0)-(W,H)`
box back onto the overlay's `(0,0)-(W,H)` regardless of how the canvas is
currently panned or zoomed. It subscribes to the shared `PanZoomHandle` for
the duration of the maximized state (`enter()`/`exit()`, both idempotent) so
panning or zooming *while* a window is maximized keeps it filling the
screen instead of sliding out from under itself. Table and view windows
share the exact same helper and the exact same live `PanZoomHandle`
(exposed via `currentPanZoom()` so the view-window manager, initialized
separately, can reuse the table manager's canvas instance).

## Practical implications

- **A panel's on-screen position is not its "real" position while minimized
  or maximized.** Both `saveGeometry` functions special-case those two
  states and reuse the last normalized rect rather than reading
  `offsetLeft`/`offsetTop`, which would otherwise persist jsPanel's `-9999`
  minimize-parking coordinate or the maximized full-container size as if it
  were the user's intended layout.
- **Z-order is a timestamp, not a DOM read.** Anything that needs "is this
  panel on top" has to go through the persisted `windowGeometry.z`
  (`onfronted` → `stampFrontOrder`) — reading `element.style.zIndex`
  directly would see jsPanel's renormalized, momentarily-identical value
  instead of a stable per-panel ordering.
- **Off-screen geometry is a feature, not a bug to guard against.** Don't
  "fix" a window that restores partially or fully outside the viewport —
  that's expected, and the pan/zoom canvas (or a double-tap reset on touch)
  is the intended way back, not a geometry clamp.
