// packages/renderer/src/plugins/views.ts
//
// The View system (built-in plugin).
//
//   - A ViewTemplate (workspace-global) is header/row/footer HTML that decides
//     how a table is displayed. Blank row HTML => a read-only columns table;
//     otherwise the row HTML repeats per row with $TOKEN placeholders. A
//     $input.TOKEN renders an editable control bound to the mapped column.
//   - A ViewInstance ties a template to ONE table, snapshotting its sort /
//     filter / visible columns and mapping the template's $TOKENs to columns.
//     It opens in its own window.
//
// This plugin owns only DATA + INTENT: it seeds the default templates and adds
// a "Views" button to each table's footer (opening the manager dialog). The
// actual view *windows* -- opening, geometry, persistence, maximize behaviour,
// and boot-time restore -- are owned by the CORE window manager
// (`window-mgr/view-window-manager.ts`), driven by the `ViewInstance.open` flag
// the dialog flips. Plugins must not manage windows themselves.

import type { HostApi, PluginModule } from '@easydb/shared';
import { openViewsDialog } from '../dialogs/views-dialog.js';
import { seedDefaults } from './views-seed.js';

export const meta: NonNullable<PluginModule['meta']> = {
  id: 'views',
  name: 'Views',
  type: 'ui',
  version: '0.1.0',
  description: 'Display tables through HTML view templates in read-only windows.',
  author: 'easyDBAccess built-ins',
  icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>',
  repo: 'https://github.com/cawoodm/easydbaccess/blob/main/packages/renderer/src/plugins/views.ts',
};

// Footer/table buttons render their `icon` as a Material Icons ligature (see
// panel-footer.ts) -- NOT as raw SVG (that's the header-button convention). Use
// the icon name here so it renders as a glyph instead of garbled markup.
const VIEWS_ICON = 'grid_view';

// --- Built-in templates ------------------------------------------------------
// Each is reconciled into the workspace on load (see seedDefaults). `slug` keys
// its per-workspace "seeded"/"signature" settings; keep it stable. `rss` MUST
// stay `rss` so already-seeded workspaces are not re-seeded.

export function init(api: HostApi): void {
  // Footer "Views" icon on every table. Everything past opening the dialog is
  // core: the dialog flips `ViewInstance.open` and the core view-window manager
  // opens/closes/persists the windows.
  api.ui.registerTableButton({
    id: 'views:open',
    label: 'Views',
    icon: VIEWS_ICON,
    tooltip: 'Views -- display this table through a template',
    onClick: (_a, { tableId }) => openViewsDialog(tableId),
  });
}

export async function load(api: HostApi): Promise<void> {
  await seedDefaults(api);
}

