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

- **Ctrl+Enter / Cmd+Enter submits.** `ctrlEnterSubmits(e)`, wired as
  `@keydown` on the `<dialog>`, calls `form.requestSubmit()` regardless of
  which input/textarea/select inside currently has focus — so the shortcut
  works everywhere in the dialog, not just when a specific field is
  focused.
- **Mobile goes full-screen.** A `@media (max-width: 640px)` block forces
  every *open* dialog to `position: fixed; inset: 0` edge-to-edge,
  overriding each dialog's own width/position (including an in-progress
  drag — see below). The rule is scoped to `dialog[open]` specifically —
  the comment in the source is emphatic about this — because a bare
  `dialog { display: flex !important }` would override the user-agent's
  `dialog:not([open]) { display: none }` and leave a *closed* dialog
  visibly on screen, blocking the whole UI permanently.

## Dragging a native `<dialog>`

`<dialog>` centers itself on `showModal()` and has no built-in way to be
repositioned. `makeDialogDraggable(dialog, handle)`
([`dialogs/draggable.ts`](../packages/renderer/src/dialogs/draggable.ts))
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

## `<app-shell>` — the mount point and the header/footer slot host

`<app-shell>` is where all of this converges. It mounts `<host-dialogs>`
and `<toast-host>` exactly once, alongside the handful of dialogs that are
always-present chrome rather than plugin-registered (`new-table-dialog`,
`csv-paste-dialog`, `plugin-manager-dialog`, `script-editor-dialog`).

Opening one of those built-in dialogs from plugin code goes through a
**document-level custom event**, not a direct method call —
`api.ui.openNewTableDialog()` just dispatches `easydb:open-new-table` on
`document`, and `<app-shell>` listens for it and calls `this.dialog.open()`.
This indirection exists because table/view **panels live in light DOM**
(mounted into `#easydb-panels`, outside any shadow root — see
`WINDOWS.md`), so a jsPanel titlebar action (e.g. "Edit columns") can't hold
a direct reference into `<app-shell>`'s shadow DOM; a bubbling `document`
event is the one channel both sides can reach.

`<app-shell>` also owns:

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
