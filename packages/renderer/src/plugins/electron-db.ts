/**
 * electron-db — Open / Save As / Import a `.db` file. Electron-only: it
 * registers nothing at all — no footer button, no menu entry, no error — when
 * `window.easydb?.db` is absent, which is always true in the browser build
 * (see `packages/electron/src/preload.ts` for the bridge this reads). That
 * guard in `init()` below is the one hard requirement for this plugin.
 *
 * A single footer button opens an anchored menu (Open… / Save As… / Import…)
 * rather than three separate buttons, matching how `gist-sync.ts` groups its
 * own multi-action footer button.
 */
import type { HostApi, PluginModule } from '@easydb/shared';
import type { EasydbDbBridge, EasydbImportDecision, EasydbImportedTableResult } from '../db/data-store-ipc.js';

export const meta: NonNullable<PluginModule['meta']> = {
  id: 'electron-db',
  name: 'Database File',
  type: 'ui',
  version: '0.1.0',
  description: 'Open, Save As, or Import a .db file (Electron desktop build only).',
  author: 'Marc Cawood',
  icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v6c0 1.66 3.58 3 8 3s8-1.34 8-3V5"/><path d="M4 11v6c0 1.66 3.58 3 8 3s8-1.34 8-3v-6"/></svg>',
  repo: 'https://github.com/cawoodm/easydbaccess/blob/main/packages/renderer/src/plugins/electron-db.ts',
};

export function init(api: HostApi): void {
  const bridge = window.easydb?.db;
  if (!bridge) return; // browser build — no bridge, no UI, nothing to do

  api.ui.registerFooterButton({
    id: 'electron-db:menu',
    label: 'Database',
    icon: 'storage',
    tooltip: 'Open, Save As, or Import a .db file',
    onClick: async (api, ctx) => {
      const { AnchoredMenu } = await import('../chrome/anchored-menu.js');
      const rect =
        ctx?.anchor?.getBoundingClientRect() ?? new DOMRect(16, window.innerHeight - 48, 0, 0);
      const choice = await AnchoredMenu.open(rect, [
        { id: 'open', label: 'Open…', icon: 'folder_open' },
        { id: 'saveAs', label: 'Save As…', icon: 'save' },
        { id: 'import', label: 'Import…', icon: 'file_download' },
      ]);
      if (!choice) return;
      try {
        if (choice === 'open') await openFlow(api, bridge);
        else if (choice === 'saveAs') await saveAsFlow(api, bridge);
        else if (choice === 'import') await importFlow(api, bridge);
      } catch (err) {
        api.ui.dialogs.toast(`${choice} failed: ${(err as Error).message}`, {
          kind: 'error',
          title: 'Database file',
        });
      }
    },
  });
}

// -- Open ---------------------------------------------------------------------
//
// `bridge.openDb()` only runs the OS file picker (no side effects); the
// actual switch — which replaces the whole workspace view — only happens
// after the user confirms IN-APP, naming the exact file just picked. See
// `db-files.ts`'s `pickDatabaseToOpen`/`switchToDatabase` for the main-side
// half of this split.

async function openFlow(api: HostApi, bridge: EasydbDbBridge): Promise<void> {
  const picked = await bridge.openDb();
  if (!picked.ok) return; // cancelled in the OS dialog
  const yes = await api.ui.dialogs.confirm(
    `Open "${picked.path}"?\n\nThis replaces the current workspace view with that file's data. ` +
      `Nothing is deleted — the file you have open now is left exactly as it is on disk.`,
    'Open database',
  );
  if (!yes) return;
  // The main process reloads this window once it has switched — nothing to
  // do with the result here, the reload re-initialises app-context.ts fresh.
  await bridge.openDbCommit(picked.path);
}

// -- Save As --------------------------------------------------------------
//
// A single round trip: `db-files.ts`'s `saveDbAs` copies the current file to
// the chosen path and then makes that copy the active file (the report
// explains why) — there is nothing here for the renderer to confirm, since
// the copy doesn't change what's on screen.

async function saveAsFlow(api: HostApi, bridge: EasydbDbBridge): Promise<void> {
  const result = await bridge.saveDbAs();
  if (!result.ok) return; // cancelled in the OS dialog
  api.ui.dialogs.toast(`Saved a copy to "${result.path}" — that file is now the active database.`, {
    kind: 'success',
    title: 'Save database as',
  });
}

// -- Import -------------------------------------------------------------------
//
// Two-phase: `bridge.importDb()` picks a file and returns a PREVIEW (table
// names, row counts, which collide with an existing table in this
// workspace) without writing anything; this flow then asks the same
// Overwrite / Rename / Skip question `datasette-connect.ts` asks for a name
// clash, once per colliding table, before calling `importDbCommit` to
// actually write.

async function importFlow(api: HostApi, bridge: EasydbDbBridge): Promise<void> {
  const workspaceId = api.workspaceId();
  if (!workspaceId) throw new Error('no active workspace');

  const picked = await bridge.importDb(workspaceId);
  if (!picked.ok) return; // cancelled in the OS dialog
  const { preview } = picked;
  if (preview.candidates.length === 0) {
    await api.ui.dialogs.alert(`No importable tables were found in "${picked.path}".`, 'Import database');
    return;
  }

  // Local table names, for proposing a unique rename target — same
  // case-insensitive rule the rest of the app uses (see `uniqueTableName` in
  // `datasette-common.ts`). Recomputed as a running set so two colliding
  // candidates in the SAME import batch can't rename to the same target.
  const takenNames = new Set(
    (await api.store.tables.find())
      .filter((t) => t.workspaceId === workspaceId)
      .map((t) => t.name.toLowerCase()),
  );

  const decisions: Record<string, EasydbImportDecision> = {};
  for (const c of preview.candidates) {
    if (!c.collides) continue;
    const choice = await api.ui.dialogs.choice(
      `A table named "${c.name}" already exists in this workspace.`,
      ['Overwrite', 'Rename', 'Skip'],
      'Import — table already exists',
    );
    if (!choice || choice === 'Skip') {
      decisions[c.name] = { action: 'skip' };
      continue;
    }
    if (choice === 'Overwrite') {
      decisions[c.name] = { action: 'overwrite' };
      continue;
    }
    const renameTo = uniqueName(c.name, takenNames);
    takenNames.add(renameTo.toLowerCase());
    decisions[c.name] = { action: 'rename', renameTo };
  }

  const results = await bridge.importDbCommit(picked.path, workspaceId, decisions);
  reportImportResults(api, picked.path, results);
}

/** `name`, or `name (2)`, `name (3)`, … — first not already in `taken` (case-insensitive). */
function uniqueName(name: string, taken: Set<string>): string {
  if (!taken.has(name.toLowerCase())) return name;
  for (let i = 2; ; i++) {
    const candidate = `${name} (${i})`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}

function reportImportResults(api: HostApi, path: string, results: EasydbImportedTableResult[]): void {
  const byAction = {
    created: results.filter((r) => r.action === 'created').length,
    renamed: results.filter((r) => r.action === 'renamed').length,
    overwritten: results.filter((r) => r.action === 'overwritten').length,
    skipped: results.filter((r) => r.action === 'skipped').length,
  };
  const totalRows = results.reduce((n, r) => n + r.rowCount, 0);
  const parts: string[] = [];
  if (byAction.created) parts.push(`${byAction.created} new`);
  if (byAction.renamed) parts.push(`${byAction.renamed} renamed`);
  if (byAction.overwritten) parts.push(`${byAction.overwritten} overwritten`);
  if (byAction.skipped) parts.push(`${byAction.skipped} skipped`);
  if (parts.length === 0) {
    api.ui.dialogs.toast(`Nothing imported from "${path}".`, { kind: 'warning', title: 'Import database' });
    return;
  }
  api.ui.dialogs.toast(
    `Imported from "${path}": ${parts.join(', ')} (${totalRows} row${totalRows === 1 ? '' : 's'} total).`,
    { kind: 'success', title: 'Import database' },
  );
}
