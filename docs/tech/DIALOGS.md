# Dialogs & Chrome

How modal dialogs, toasts, and the app-wide header/footer chrome are built
and wired together. This is core UI infrastructure every plugin touches
indirectly through `api.ui.dialogs` (see [`PLUGINS.md`](./PLUGINS.md)'s
`HostApi` surface table) but never constructs directly.

## Why not just `window.alert`/`window.confirm`/`window.prompt`

Native browser dialogs are synchronous, block the whole tab, look
completely unstyled, and behave inconsistently (or not at all) inside
Electron. `api.ui.dialogs` — `alert`/`confirm`/`prompt`/`choice`/`toast` —
is a Promise-returning replacement for all of them, so behavior stays
identical across the browser build and the Electron shell (see
[`ELECTRON.md`](./ELECTRON.md)) and so plugin code can `await` a user
decision instead of relying on a blocking call. Every built-in plugin uses
this surface exclusively; there is no `window.confirm(...)` left anywhere
in first-party code.

## Two singleton chrome elements, resolved lazily

The actual UI lives in two Lit elements mounted once by `<app-shell>`:
`<host-dialogs>` (alert/confirm/prompt/choice) and `<toast-host>` (the
non-modal toast stack). Both register themselves on a **static `.instance`**
field in `connectedCallback()` and clear it in `disconnectedCallback()` —
the same singleton-discovery pattern used elsewhere in the renderer (the
Import dialog, the filter popover).

`api.ui.dialogs` itself (`plugin-host/registries.ts`) is not a direct
reference to `<host-dialogs>` — it's a **lazy proxy** that looks up
`HostDialogs.instance`/`ToastHost.instance` fresh on every call:

```ts
async alert(message, title) {
  const h = HostDialogs.instance;
  if (h) return h.alert(message, title);
  window.alert(message);       // fallback — see below
},
```

This has to be a proxy, not a captured reference, because of boot ordering:
plugin `init(api)` runs (see `PLUGINS.md`'s plugin lifecycle) **before**
`<app-shell>` has necessarily rendered and mounted `<host-dialogs>` into the
DOM. A plugin that calls `api.ui.dialogs.alert(...)` from inside `init()`
would otherwise crash on a null reference. The fallback to the real
`window.alert`/`confirm`/`prompt` (and a `console.log` for `toast`) exists
purely to cover that narrow pre-mount race — it is not a supported code
path plugins should rely on; in every steady-state call, `.instance` is set.

## `<host-dialogs>` — one native `<dialog>`, four states

`HostDialogs` is a single `<dialog>` element that renders a different body
depending on a `current: AlertState | PromptState | ChoiceState | null`
field:

- **`alert(message, title)`** — a message + OK button.
- **`prompt(message, defaultValue, title)`** — message + text input,
  resolves to the entered string or `null` on cancel.
- **`choice(message, options, title)`** — message + a vertical list of
  buttons, one per option; resolves to the chosen string or `null`.
- **`confirm(message, title)`** is not its own state — it's implemented as
  `choice(message, ['Yes', 'No'], title)` with the result mapped to a
  boolean. One fewer state machine to maintain.

**Only one dialog is ever open at a time.** A call made while `current` is
already set doesn't overwrite it — it's pushed onto a `queue: (() =>
void)[]` and started only once `closeAndResolve` finishes the current one.
So a plugin (or several plugins) firing off multiple `alert()`/`confirm()`
calls in quick succession get them presented one after another, not
stacked or silently dropped.

Resolution always happens **after** the native `<dialog>` closes
(`queueMicrotask` inside `closeAndResolve`), so any code `await`ing the
promise sees the dialog already gone from the DOM rather than mid-close-
animation. Cancelling — Escape, the corner `×`, or a genuine backdrop
`cancel` event — resolves `alert` with `undefined` and `prompt`/`choice`
with `null`, funneled through one `onCancel` handler so every dismissal
path (keyboard, click, programmatic) behaves identically.

## `<toast-host>` — non-modal, stacking, auto-dismissing

Toasts are unrelated to the modal `<dialog>` — a fixed-position, top-center
stack of cards (`z-index: 200000`, `pointer-events: none` on the container
so only the cards themselves are interactive) that don't block anything.
Each `show(message, { kind, title, durationMs })` call appends a new toast
with an auto-dismiss timer: `durationMs` if given, else 4000ms for
`info`/`success` and 7000ms for `warning`/`error` — sticky-ish so an actual
problem doesn't vanish before it's read. A left-border accent color + icon
(`check_circle`/`error`/`warning`/`info`) marks the `kind`; a small
`linkify()` helper turns any `https?://` substring in the message into a
real clickable `<a target=_blank>` without needing the caller to pre-format
it — useful for toasts that report a Gist/sync URL (`gist-sync`'s Push
toast, see `PLUGINS.md`).

## Shared dialog chrome (`dialog-chrome.ts`)

Every dialog in `packages/renderer/src/dialogs/` — `<host-dialogs>` and
every feature dialog (New Table, CSV Paste, Plugin Manager, Import, Views,
Column Names, Table Info, Datasette Connect, …) — imports one shared
`dialogChromeStyles` and follows the same DOM shape:

```html
<dialog>
  <button class="close-x">×</button>
  <form>
    <div class="dialog-header">
      <h2>Title</h2>
      <div class="header-actions">
        <button class="ghost">Cancel</button>
        <button class="primary">Save</button>
      </div>
    </div>
    <div class="dialog-body">…</div>
  </form>
</dialog>
```

This is what gives every dialog in the app the same dark header bar,
button styling, and spacing without each one re-implementing it. Two
behaviors are baked into the shared styles/helper rather than left to each
dialog to reimplement:

- **Ctrl+Enter / Cmd+Enter confirms; Esc closes.** `ctrlEnterSubmits(e)`,
  wired as `@keydown` on the `<dialog>`, calls `form.requestSubmit()`
  regardless of which input/textarea/select inside currently has focus — so
  the shortcut works everywhere in the dialog, not just when a specific
  field is focused. Esc closing is native `<dialog>`/`cancel` behavior and
  needs no explicit wiring beyond a `@cancel` handler that resolves the
  dialog's promise. **Every dialog in the app follows this convention** —
  it was audited and retrofitted onto the few that didn't (Settings, Table
  Info, Share Workspace, the Views manager, the multi-table picker). The
  retrofit's one sharp edge: wrapping previously-formless dialog content in
  a `<form>` turns any bare `<button>` inside it into an implicit
  `type="submit"` — the Views manager's list-mode row buttons (Open / Edit
  / Delete / Use / Copy) all needed an explicit `type="button"` added so
  clicking them didn't also submit (and close) the dialog.
- **Mobile goes full-screen.** A `@media (max-width: 640px)` block forces
  every _open_ dialog to `position: fixed; inset: 0` edge-to-edge,
  overriding each dialog's own width/position (including an in-progress
  drag — see below). The rule is scoped to `dialog[open]` specifically —
  the comment in the source is emphatic about this — because a bare
  `dialog { display: flex !important }` would override the user-agent's
  `dialog:not([open]) { display: none }` and leave a _closed_ dialog
  visibly on screen, blocking the whole UI permanently.

## Dragging a native `<dialog>`

`<dialog>` centers itself on `showModal()` and has no built-in way to be
repositioned. `makeDialogDraggable(dialog, handle)`
([`dialogs/draggable.ts`](../../packages/renderer/src/dialogs/draggable.ts))
wires pointer-capture dragging on a handle (in practice, the `.dialog-header`
bar) — `pointerdown` records the dialog's current rect, `pointermove`
translates it via inline `left`/`top` (which overrides the browser's
centering `margin: auto`), clamped so at least 80px of the dialog always
stays reachable within the viewport. It's guarded by a `WeakSet` so
re-invoking on the same handle element is a no-op — necessary because Lit
re-renders can recreate the header node on a template switch (e.g.
`<host-dialogs>` swapping between alert/prompt/choice bodies), and the
helper is called again on every `updated()` to rebind the fresh node.
Clicking an interactive descendant (`button, input, textarea, select, a,
label`) inside the handle is excluded from starting a drag, so e.g. a
Cancel button living inside the header bar still receives its click instead
of the drag capturing the pointer first.

## Anchored menus (`anchored-menu.ts`)

Not a modal `<dialog>` at all — a small dropdown menu, used when a footer
button's job is "pick one of a few actions" rather than "do the one thing
this button does." `AnchoredMenu.open(rect, items)` self-mounts a singleton
`<anchored-menu>` (same lazy-singleton pattern as `<toast-host>` and the
filter popover), positions it just under the given viewport-space `rect`
(flipping to open _above_ the rect if it would overflow the bottom of the
screen — useful since these are mostly opened from the footer), and
resolves to the clicked item's `id` or `null` on outside-click/Escape. A
button's `onClick(api, ctx)` gets `ctx.anchor` — its own DOM element — from
the host precisely so it can hand `anchor.getBoundingClientRect()` to
`AnchoredMenu.open()` and have the menu appear right under itself rather
than at a guessed fixed position.

**Escape closes every transient layer, and exactly one of them.** The convention
is a capture-phase `keydown` listener on `document` that calls `preventDefault()`
— the anchored menu, the filter popover (`chrome/filter-popover.ts`) and the cell
editors all do this — because `panel-shell`'s own Escape handler bails out on
`e.defaultPrevented`. That is what stops one press closing the popover AND the
window behind it. Dismissing the filter popover this way keeps whatever was
already ticked: each value is applied as it is clicked, so Escape means "done with
the list", not "undo".

This is what replaced several plugins' one-button-per-action footer
buttons with a single button opening a menu: `gist-sync` (Push / Pull /
Settings / Share / View gist, plus a per-table variant), `server-sync`
(Push / Pull), and `dump-export` (JSON dump / SQL script) — see
`PLUGINS.md`'s Sync and Exporters sections. Reach for `AnchoredMenu` instead
of a full dialog whenever a footer/table button's job is picking one of a
short, static list of actions.

## The Settings dialog (`settings-dialog.ts`)

One dialog, two kinds of content: a fixed **General** tab (workspace title,
the cross-workspace secrets editor) and one tab per plugin that called
`api.ui.registerSettings(pluginId, name, fields)` — see `PLUGINS.md`'s
Settings section and `STORAGE.md`'s settings-model writeup for the layered
storage this dialog edits. A left-hand `<nav>` lists the tabs; the active
one renders its fields via a `renderControl()` switch keyed on each field's
declared `type` (`string`/`text`/`number`/`boolean`/`date`/`secret`/
`option`/`selection`).

Two things are specific to this dialog, not the shared chrome:

- **No Save button — fields save on `change`.** Every control's change
  handler calls `ctx.api.settings.set(...)` immediately; "Done" (and
  Ctrl+Enter) just closes the already-saved dialog. `type="secret"` gets an
  extra `<select>` next to its input listing every name currently in the
  secrets store, letting the user insert a `${secret:name}` reference
  without typing the token.
- **Per-field promote/demote.** Every field row carries a small "user"
  checkbox — checked means the value lives in the device-local user layer,
  unchecked means the synced workspace layer (see `STORAGE.md`). Toggling
  it calls `ctx.api.settings.set(..., scope)`, which the resolver treats as
  a move: the value is written to the new layer and removed from the old
  one, so a key is never split across both.

Like every other dialog since the Ctrl+Enter audit, its `<dialog>` wraps a
real `<form>` (header + body inside it, "Done" as `type="submit"`) with
`@keydown=${ctrlEnterSubmits}` — and the two tab-nav `<button>`s needed an
explicit `type="button"` for the same reason called out above.

## `<app-shell>` — the mount point and the header/footer slot host

`<app-shell>` is where all of this converges. It mounts `<host-dialogs>`
and `<toast-host>` exactly once, alongside the handful of dialogs that are
always-present chrome rather than plugin-registered (`new-table-dialog`,
`csv-paste-dialog`, `plugin-manager-dialog`, `settings-dialog`,
`script-editor-dialog`). A few more (`views-dialog`, `gist-share-dialog`,
`table-info-dialog`, `table-select-dialog`) mount themselves lazily on
first use instead, via the singleton-`instance` + `mount()`-into-`body`
pattern.

Opening one of those built-in dialogs from plugin code goes through a
**document-level custom event**, not a direct method call —
`api.ui.openNewTableDialog()` just dispatches `easydb:open-new-table` on
`document`, and `<app-shell>` listens for it and calls `this.dialog.open()`.
This indirection exists because table/view **panels live in light DOM**
(mounted into `#easydb-panels`, outside any shadow root — see
`WINDOWS.md`), so a panel titlebar action (e.g. "Edit columns") can't hold
a direct reference into `<app-shell>`'s shadow DOM; a bubbling `document`
event is the one channel both sides can reach.

`<app-shell>` also owns:

- **The header title** — subscribes to the current `Workspace` record and
  renders `title || 'easyDBAccess'` (see `STORAGE.md`'s `Workspace.title`),
  live-updating the instant the Settings dialog's "Workspace title" field
  changes, no reload needed. The version number next to it is wrapped in an
  `<a>` to the `CHANGELOG.md` file on GitHub (`target=_blank`) — the inner
  `<span class="version">` is kept exactly as-is so `scripts/bump-version.mjs`
  can keep rewriting it on every commit without caring about the link
  around it.
- **The header/footer button slots** — `headerButtons`/`footerButtons`
  snapshotted from the registries (see `PLUGINS.md`) and re-snapshotted on
  `app:ready` so late-registering plugins' buttons appear without a reload.
  An icon string starting with `<svg` renders as inline SVG; anything else
  is treated as a Material Icons ligature name.
- **The global search box** — a collapsible header input that debounces
  (200ms) and broadcasts `easydb:global-search`, which every open
  `<data-table>` listens for independently (see `DATA-TABLE.md`'s filtering
  section) rather than the shell filtering anything itself; panels are
  deliberately never hidden by a global search, only their row sets
  narrowed, so the user can keep scanning multiple tables at once.
- **Workspace-wide drag-and-drop** — `dragover`/`drop` on the shell itself
  (with a pulsing "Drop CSV or JSON here" overlay) runs every registered
  `dropHandlers` function in turn (see `PLUGINS.md`'s `registerDropHandler`)
  until one returns `true`, and emits `drop:files` regardless so any plugin
  listening on the event bus sees the raw drop even if a specific handler
  already claimed it.

## A dialog never waits on a data read to open

The columns editor learned this the hard way. Its live preview was awaited
BEFORE `showModal()`, over `store.rows(id).find()` — the whole table. On a
609k-row table that is seconds and ~15 MB to show a hundred rows, so the editor
appeared long after the click, and a read that failed outright left it open
saying "No rows to preview" — the one thing that was not true.

The shape to copy (`new-table-dialog.ts`'s `loadPreview`):

- show the dialog on what you already have (here: the `Table` doc), then start
  the read;
- ASK for what you show — `readRows(coll, { columns, limit: 100 }, 100)`, so the
  Electron store turns it into `LIMIT` and the cap bounds the backends with no
  `query`;
- keep a token that a reopen increments, and drop an answer whose token is
  stale — a slow read outliving its dialog is exactly the case here;
- give the empty state three readings — reading, nothing there, could not be
  read. One message for all three is a bug report waiting to happen.

## Practical implications

- **Always use `api.ui.dialogs`, never `window.*`, in plugin code.** The
  fallback to native browser dialogs exists only to survive the pre-mount
  race at plugin `init()` time — it is not a sanctioned alternative, and
  relying on it means losing consistent styling and Electron parity.
- **A dialog you add should import `dialogChromeStyles`** and follow the
  header/body/close-x shape, not invent its own chrome — that's what keeps
  New Table, CSV Paste, Plugin Manager, Import, Views, etc. all looking
  like one application instead of a pile of ad hoc modals.
- **Don't hold onto a `HostDialogs`/`ToastHost` instance reference** across
  awaits or renders — always resolve `.instance` at the point of the call,
  exactly like the registries proxy does, since the underlying element can
  in principle be torn down and remounted.
