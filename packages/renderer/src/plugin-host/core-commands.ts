import type { HostApi } from '@easydb/shared';
import { arrangeInColumns, arrangeInRows, cascadeAllWindows, closeAllWindows, maximizeAllWindows, minimizeAllWindows, restoreAllWindows, tileAllWindows } from '../window-mgr/window-commands.js';
import { deleteWorkspaceFlow, newWorkspaceFlow, switchWorkspaceFlow } from '../chrome/workspace-actions.js';

/**
 * Registers the built-in "Windows" commands into the command palette. Called
 * once at boot (app-context) so they're present before any plugin runs. These
 * are core (not a plugin) because they drive the core window manager directly;
 * plugins add their own commands via `api.ui.registerCommand`.
 */
export function registerCoreCommands(api: HostApi): void {
  const windowCommands: Array<{ id: string; title: string; icon: string; run: () => void }> = [
    { id: 'windows:minimize-all', title: 'Minimize all windows', icon: 'remove', run: minimizeAllWindows },
    { id: 'windows:restore-all', title: 'Restore all windows', icon: 'crop_square', run: restoreAllWindows },
    { id: 'windows:maximize-all', title: 'Maximize all windows', icon: 'fullscreen', run: maximizeAllWindows },
    { id: 'windows:cascade', title: 'Cascade windows', icon: 'view_agenda', run: cascadeAllWindows },
    { id: 'windows:tile', title: 'Tile windows', icon: 'grid_view', run: tileAllWindows },
    { id: 'windows:columns', title: 'Arrange windows in columns', icon: 'view_column', run: arrangeInColumns },
    { id: 'windows:rows', title: 'Arrange windows in rows', icon: 'table_rows', run: arrangeInRows },
    { id: 'windows:close-all', title: 'Close all windows', icon: 'close', run: closeAllWindows },
  ];
  for (const c of windowCommands) {
    api.ui.registerCommand({ id: c.id, title: c.title, group: 'Windows', icon: c.icon, run: c.run });
  }

  // Workspace commands. The header selector drives the same flows with a mouse;
  // these make switching, adding and deleting reachable from the keyboard.
  const workspaceCommands: Array<{ id: string; title: string; icon: string; keywords: string[]; run: () => Promise<void> }> = [
    { id: 'workspace:switch', title: 'Switch workspace', icon: 'swap_horiz', keywords: ['space', 'open', 'change'], run: switchWorkspaceFlow },
    { id: 'workspace:new', title: 'New workspace', icon: 'add', keywords: ['space', 'add', 'create', 'clone'], run: newWorkspaceFlow },
    { id: 'workspace:delete', title: 'Delete workspace', icon: 'delete', keywords: ['space', 'remove', 'drop'], run: deleteWorkspaceFlow },
  ];
  for (const c of workspaceCommands) {
    api.ui.registerCommand({ id: c.id, title: c.title, group: 'Workspace', icon: c.icon, keywords: c.keywords, run: c.run });
  }

  const CHANGELOG_URL = 'https://github.com/cawoodm/easydbaccess/blob/main/CHANGELOG.md';
  const DOCS_URL = 'https://github.com/cawoodm/easydbaccess/tree/main/docs';

  api.ui.registerCommand({
    id: 'app:search',
    title: 'Search all tables',
    group: 'App',
    icon: 'search',
    keywords: ['find', 'global search', 'filter'],
    run: () => {
      document.dispatchEvent(new CustomEvent('easydb:focus-search'));
    },
  });
  api.ui.registerCommand({
    id: 'app:plugins',
    title: 'Plugins',
    group: 'App',
    icon: 'extension',
    keywords: ['plugin manager', 'install', 'extensions'],
    run: (a) => a.ui.openPluginManager(),
  });
  api.ui.registerCommand({
    id: 'app:changelog',
    title: 'Changelog',
    group: 'App',
    icon: 'history',
    keywords: ['releases', 'version', 'whats new'],
    run: () => {
      window.open(CHANGELOG_URL, '_blank', 'noopener');
    },
  });
  api.ui.registerCommand({
    id: 'app:docs',
    title: 'Documentation',
    group: 'App',
    icon: 'menu_book',
    keywords: ['docs', 'help', 'guide', 'manual'],
    run: () => {
      window.open(DOCS_URL, '_blank', 'noopener');
    },
  });
}
