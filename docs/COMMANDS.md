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
   first if minimized), via `focusTableWindow(tableId)` in
   `window-mgr/jspanel-manager.ts`.

Entries are grouped by `CommandSpec.group` and ordered **Windows → Actions →
Tables → (other groups)**; within a group, registration order is preserved.

## Built-in commands

Registered in `plugin-host/core-commands.ts` (`registerCoreCommands`, called
once at boot from `app-context.ts`), all in the **Windows** group. The bulk
window operations live in `window-mgr/window-commands.ts` and act on **every**
open panel — table windows *and* view-instance windows — via jsPanel's global
`getPanels()` registry:

| Command | Action |
|---|---|
| Minimize all windows | Minimize every panel. |
| Restore all windows | Normalize every panel (undo minimize/maximize). |
| Maximize all windows | Maximize every panel. |
| Cascade windows | Normalize + stagger each window down-right. |
| Tile windows | Normalize + arrange in a grid. |
| Close all windows | Close every panel. |

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
