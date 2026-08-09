# Commands & the Command Palette

The **command palette** is a keyboard-driven launcher for workspace actions.
Press **Ctrl+K** (or **Cmd+K** on macOS) to open it, type to filter, use
**↑/↓** to move, **Enter** to run, and **Esc** to close. It's core chrome —
not a plugin — but its list is open: any plugin can add entries.

## What shows up in the palette

The palette composes its list fresh each time it opens, from three sources:

1. **Registered commands** — anything added via `api.ui.registerCommand(...)`.
   This includes the built-in **Windows** commands and any commands plugins
   register.
2. **Aggregated buttons** — every header and footer button
   (`registries.headerButtons` + `footerButtons`) is surfaced automatically as
   a command in the **Actions** group, running the button's own `onClick`. So
   *New Table*, *Import*, *Export*, *Gist*, *Sync*, *Settings*, etc. are
   reachable from the palette without any extra registration.
3. **Go to <table>** — one entry per table in the current workspace (the
   **Tables** group). Running it focuses that table's window (restoring it
   first if minimized, or un-hiding it if closed), via `focusTableWindow(tableId)`
   in `window-mgr/table-window-manager.ts`.
4. **Go to view <name>** — one entry per view instance (the **Views** group).
   Running it opens the view's window if closed (by flipping the instance's
   `open` flag, which the view-window manager reacts to) and fronts it via
   `focusViewWindow(instanceId)` in `window-mgr/view-window-manager.ts`.

Entries are grouped by `CommandSpec.group` and ordered **Windows → Actions →
Tables → (other groups)**; within a group, registration order is preserved.

## Recent

The last five commands that ran move to the front under a **Recent** group
(`dialogs/palette-recent.ts`, ids in the workspace setting `palette:recent`), so
Ctrl+K Enter repeats the last one. The entries MOVE rather than being copied, so
nothing is listed twice and index 0 is always the last command.

A "Go to" id carries its object's id (`goto:<tableId>`, `goto-view:<instanceId>`),
so deleting the table leaves an id here that names nothing. `pruneRecent` drops
those when the palette opens, and writes the shorter list back only if something
actually went — opening the palette is otherwise not a store write. Pruned on READ
rather than on delete because a table can leave in several ways (the trash button,
a workspace delete, a sync that pulls a workspace without it) and each of them
would otherwise have to remember to call a cleanup. A rename needs no cleanup at
all: the id does not change.

## Built-in commands

Registered in `plugin-host/core-commands.ts` (`registerCoreCommands`, called
once at boot from `app-context.ts`), in the **Windows**, **Workspace** and
**App** groups. The bulk
window operations live in `window-mgr/window-commands.ts` and act on **every**
open panel — table windows *and* view-instance windows — via the panel
shell's global `getPanels()` registry:

| Command | Action |
|---|---|
| Minimize all windows | Minimize every panel. |
| Restore all windows | Normalize every panel (undo minimize/maximize). |
| Maximize all windows | Maximize every panel. |
| Cascade windows | Normalize + stagger each window down-right. |
| Tile windows | Normalize + arrange in a grid. |
| Close all windows | Close every panel. |

The **Workspace** group holds the three things you can do to a workspace. The
flows themselves are in `chrome/workspace-actions.ts`, shared with the header's
workspace selector so the mouse and the keyboard take the same path:

| Command | Action |
|---|---|
| Switch workspace | Pick another workspace by name and open it. |
| New workspace | Name it, choose what it inherits (everything / settings / nothing), open it. |
| Delete workspace | Pick one, see what that removes, delete it and everything in it. |

Opening a workspace RELOADS the page with `?space=<name>`. Dexie collections,
panel windows and the plugin host all bind to one `workspaceId` at boot, so
switching live would mean tearing down every panel and rebinding every
subscription.

Deleting takes the workspace's tables and their rows, its view instances and
templates, and its settings (`db/delete-workspace.ts`). That last one is not
housekeeping: a workspace id is its slugified name, so a leftover settings row
would be inherited by the next workspace created under the same name. Device-
local `user` settings and cached plugin bodies stay — they belong to the device,
not the workspace. Deleting the ACTIVE workspace reloads into a survivor, or
into a fresh `default` when it was the last one.

Cascade/tile position windows within the **currently visible** region of the
pan/zoom canvas (geometry is computed in viewport-local coordinates from the
live pan/zoom transform), and set inline geometry directly — a transient view
action that intentionally isn't persisted to the store.

## Registering a command (plugins)

Call `api.ui.registerCommand(spec)` in your plugin's `init(api)`. It returns an
`Unregister` function.

```ts
export function init(api: HostApi): void {
  api.ui.registerCommand({
    id: 'my-plugin:say-hi',          // stable, unique
    title: 'Say hello',              // shown and matched in the palette
    group: 'My Plugin',              // optional heading; defaults to 'Commands'
    icon: 'waving_hand',             // Material Icons ligature name OR inline '<svg…>'
    keywords: ['greet', 'hello'],    // optional extra search terms (not shown)
    run: (api) => api.ui.dialogs.toast('Hi!'),  // sync or async
  });
}
```

### `CommandSpec`

Defined in `packages/shared/src/plugin-api.ts`:

| Field | Type | Notes |
|---|---|---|
| `id` | `string` | Stable unique id, e.g. `windows:close-all`. |
| `title` | `string` | Text shown in the palette and matched by search. |
| `group?` | `string` | Group heading. Defaults to `Commands`. |
| `icon?` | `string` | Material Icons ligature name, or inline `<svg>` markup. |
| `keywords?` | `string[]` | Extra terms that match search but aren't displayed. |
| `run(api)` | `(api) => void \| Promise<void>` | Invoked when the command is chosen. Errors are caught and logged. |

Search matches against `title`, `group`, and `keywords` (case-insensitive
substring). You don't need to register a command for something that's already a
header/footer button — those are aggregated automatically (source 2 above).

## How it's wired

| Piece | Location |
|---|---|
| `CommandSpec`, `registerCommand`, `openCommandPalette` | `packages/shared/src/plugin-api.ts` (the `UiRegistry` contract) |
| `commands` list + `registerCommand` impl + `openCommandPalette` opener | `packages/renderer/src/plugin-host/registries.ts` |
| Built-in Windows commands | `packages/renderer/src/plugin-host/core-commands.ts` |
| Bulk window operations | `packages/renderer/src/window-mgr/window-commands.ts` |
| The palette UI (search, grouping, keyboard nav) | `packages/renderer/src/dialogs/command-palette-dialog.ts` |
| Ctrl+K binding + `easydb:open-command-palette` listener + `<command-palette-dialog>` mount | `packages/renderer/src/chrome/app-shell.ts` |

`openCommandPalette()` dispatches a `easydb:open-command-palette` DOM event that
the app-shell listens for (the same opener pattern as `openSettings` /
`openPluginManager`); the app-shell also binds Ctrl+K/Cmd+K globally. Both route
to `command-palette-dialog`'s `open()`, which rebuilds the item list and shows a
modal `<dialog>`.
