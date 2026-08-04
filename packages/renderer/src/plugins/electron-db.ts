/**
 * electron-db — everything the user can do with a `.db` file. Electron-only: it
 * registers nothing at all — no footer button, no drop handler, no error — when
 * `window.easydb?.db` is absent, which is always true in the browser build
 * (see `packages/electron/src/preload.ts` for the bridge this reads). That
 * guard in `init()` below is the one hard requirement for this plugin.
 *
 * A single footer button opens an anchored menu (Open… / Save As… / Import…)
 * rather than three separate buttons, matching how `gist-sync.ts` groups its
 * own multi-action footer button.
 *
 * Two entry points bring a `.db` in — that menu's Open…, and dropping the file
 * on the window — and both funnel into `handleDatabaseFile`, which asks the one
 * question: Open Workspace / Browse / Import data. Keeping that in a single
 * place is deliberate; a dropped file and a picked file must not be offered
 * different things. Design:
 * `.claude/plans/2026-08-03-open-db-three-ways.md`.
 */
import type { HostApi, PluginModule } from '@easydb/shared';
import type {
  EasydbBrowsableObject,
  EasydbDatabaseFileKind,
  EasydbDbBridge,
  EasydbImportCandidate,
  EasydbImportDecision,
  EasydbImportPlanEntry,
  EasydbImportedTableResult,
} from '../db/data-store-ipc.js';
import { IMPORT_PROGRESS_EVENT, type ImportProgressDetail } from '../window-mgr/panel-title.js';
import { clearAppProgress, setAppProgress } from '../chrome/app-progress-signal.js';
import { ImportProgress } from './import-progress.js';

/**
 * Where an unfinished conversion records the rows it still owes. Must match
 * `PENDING_IMPORT_SETTING` in `packages/electron/src/db-convert.ts` — the two
 * packages are separate `tsc -b` projects, so this cannot be imported.
 */
const PENDING_IMPORT_SETTING = 'electron-db:pendingImport';

/**
 * Above this source-file size, EVERY window the import creates stays minimized —
 * the tables (which already do, see `db-import.ts`'s phase 1) and the
 * projections made from the file's views (which did not).
 *
 * A projection holds no rows: opening one computes its join over whole source
 * tables. `northwind.db` carries 17 views over tables of 609,283 rows, and
 * letting those windows open on arrival meant reading 1.9 million rows before the
 * first paint — the main process died outright. Minimized, they cost nothing
 * until the user asks for one.
 *
 * 15 MB is well above a hand-made database and far below the ones that hurt, so
 * a small file still opens its projections where you can see them.
 */
export const LARGE_SOURCE_BYTES = 15 * 1024 * 1024;

/**
 * The file name out of a path, for a label — a full Windows path is far too long
 * for a progress bar. Splits on either separator because the path comes from the
 * OS dialog, and falls back to the whole thing when there is no separator.
 */
function baseName(path: string): string {
  const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return cut >= 0 ? path.slice(cut + 1) || path : path;
}

/** A size for a toast: "40.2 MB". */
function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} bytes`;
}

/**
 * The run currently reporting progress, so the ONE `onImportProgress` relay
 * registered at init can feed it.
 *
 * A module-level handle rather than a per-run listener because the bridge
 * subscription is a single IPC channel set up once; re-subscribing per import
 * would leak a listener for every file the user ever opens.
 */
let progressTracker: { tracker: ImportProgress; label: string } | null = null;

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

/** Extensions the drop handler claims — the same set the OS file dialogs filter on. */
const DB_EXTENSIONS = /\.(edb|db|sqlite|sqlite3)$/i;

/**
 * A workspace file, by name. `.edb` is a SQLite database carrying our metadata;
 * a plain `.db` is somebody else's data.
 *
 * This is what lets a drop act instead of asking. The extension states the user's
 * INTENT — `.edb` means "open my workspace", `.db` means "take the data out of
 * this" — and the probe still verifies the file really is what it claims before
 * anything opens, so a mislabelled file falls back to the offer rather than being
 * trusted. Must match `WORKSPACE_EXTENSION` in `packages/electron/src/db-files.ts`;
 * the two packages are separate `tsc -b` projects, so it cannot be imported.
 */
const WORKSPACE_EXTENSION = /\.edb$/i;

export function init(api: HostApi): void {
  const bridge = window.easydb?.db;
  if (!bridge) return; // browser build — no bridge, no UI, nothing to do

  // A dropped file's EXTENSION decides what happens, with no question asked:
  // `.edb` is a workspace to open, anything else is data to import. Returning
  // false for a non-database leaves the CSV/JSON drop handlers to it.
  api.ui.registerDropHandler(async (event) => {
    const file = [...(event.dataTransfer?.files ?? [])].find((f) => DB_EXTENSIONS.test(f.name));
    if (!file) return false;
    // Electron 32 removed `File.path`; the preload's `webUtils` shim is the
    // only way to learn where a dropped file actually lives.
    const path = bridge.pathForFile(file);
    if (!path) {
      await api.ui.dialogs.alert(`"${file.name}" could not be located on disk, so it cannot be opened.`, 'Database file');
      return true;
    }
    await handleDroppedFile(api, bridge, path, WORKSPACE_EXTENSION.test(file.name));
    return true;
  });

  // Relay import progress to the window manager, which puts it in each table's
  // titlebar — visible whether the window is minimized or open.
  bridge.onImportProgress((p) => {
    document.dispatchEvent(
      new CustomEvent<ImportProgressDetail>(IMPORT_PROGRESS_EVENT, {
        detail: { tableId: p.tableId, rows: p.rows, total: p.total, ...(p.done ? { done: true } : {}) },
      }),
    );
    // The same messages also drive the one app-wide bar. It is the only progress
    // a convert can show: every window it makes is minimized, so none of the
    // per-grid bars is on screen.
    if (!progressTracker) return;
    const { tracker, label } = progressTracker;
    if (p.done) tracker.complete(p.tableId);
    else tracker.observe(p.tableId, p.rows);
    setAppProgress({
      label,
      fraction: tracker.fraction(),
      detail: `${tracker.completedTables()} of ${tracker.tableCount} table${tracker.tableCount === 1 ? '' : 's'}`,
    });
  });

  api.ui.registerFooterButton({
    id: 'electron-db:menu',
    label: 'Database',
    icon: 'storage',
    tooltip: 'Open, Save As, or Import a .db file',
    onClick: async (api, ctx) => {
      const { AnchoredMenu } = await import('../chrome/anchored-menu.js');
      const rect = ctx?.anchor?.getBoundingClientRect() ?? new DOMRect(16, window.innerHeight - 48, 0, 0);
      const choice = await AnchoredMenu.open(rect, [
        { id: 'open', label: 'Open…', icon: 'folder_open' },
        { id: 'saveAs', label: 'Save As…', icon: 'save' },
        { id: 'import', label: 'Import…', icon: 'file_download' },
        // Only while there is something to stop — an import of a big file runs
        // for tens of seconds, and it must not be a one-way door.
        ...(isImporting() ? [{ id: 'stop', label: 'Stop importing', icon: 'cancel' }] : []),
      ]);
      if (!choice) return;
      try {
        if (choice === 'open') await openFlow(api, bridge);
        else if (choice === 'saveAs') await saveAsFlow(api, bridge);
        else if (choice === 'import') await importFlow(api, bridge);
        else if (choice === 'stop') cancelImport();
      } catch (err) {
        api.ui.dialogs.toast(`${choice} failed: ${(err as Error).message}`, {
          kind: 'error',
          title: 'Database file',
        });
      }
    },
  });
}

/**
 * Runs after the workspace is resolved, which `init` cannot rely on — the
 * pending-import note is a workspace-scoped setting, so it can only be read
 * here. See `resumePendingImport`.
 */
export function load(api: HostApi): void {
  const bridge = window.easydb?.db;
  if (!bridge) return;
  void resumePendingImport(api, bridge).catch((err: unknown) => {
    api.ui.dialogs.toast(`Finishing the conversion failed: ${(err as Error).message}`, {
      kind: 'error',
      title: 'Convert to EDA',
    });
  });
}

// -- Open ---------------------------------------------------------------------
//
// `bridge.openDb()` only runs the OS file picker and CLASSIFIES what was
// picked (no side effects); the actual switch — which replaces the whole
// workspace view — only happens after the user confirms IN-APP, naming the
// exact file just picked. See `db-files.ts`'s
// `pickDatabaseToOpen`/`switchToDatabase` for the main-side half of this split.
//
// Only a file this app wrote can be OPENED. A foreign SQLite database has no
// `_easydb_tables` registry, so opening it would show an empty workspace AND
// add our two bookkeeping tables to someone else's file. Its tables can still
// be IMPORTED, so that is what we offer — reusing the already-picked path
// instead of making the user find the file again.

/** Exported for `electron-db.test.ts` — the OS file dialog can't be scripted, so the
 * branch is tested with a fake bridge instead of by clicking the real app. */
export async function openFlow(api: HostApi, bridge: EasydbDbBridge): Promise<void> {
  const picked = await bridge.openDb();
  if (!picked.ok) return; // cancelled in the OS dialog
  await handleDatabaseFile(api, bridge, picked.path, picked.kind);
}

/**
 * A dropped file, routed by what its name claims it is.
 *
 * No prompt: `.edb` opens, everything else imports. The three-way question this
 * replaces was asked on every drop, and the answer was already implied by which
 * file the user reached for.
 *
 * The probe still runs for a workspace, because the extension is only a claim. A
 * `.edb` that is not ours cannot be opened — pointing the store at it would add
 * our bookkeeping tables to someone else's file — so that case falls through to
 * the Convert/Browse offer instead of failing or, worse, succeeding.
 */
export async function handleDroppedFile(api: HostApi, bridge: EasydbDbBridge, path: string, claimsWorkspace: boolean): Promise<void> {
  if (!claimsWorkspace) {
    await importFlow(api, bridge, path);
    return;
  }
  const kind = await bridge.probeDb(path);
  if (kind === 'easydb') {
    await openWorkspaceFlow(api, bridge, path, kind);
    return;
  }
  // Named like a workspace but isn't one — say so, then offer what CAN be done.
  api.ui.dialogs.toast(`"${path}" is named as a workspace but does not contain one.`, {
    kind: 'warning',
    title: 'Open workspace',
  });
  await handleDatabaseFile(api, bridge, path, kind);
}

/**
 * The ONE question asked about a `.db`, wherever it came from — the Database
 * menu or a drag-and-drop. Both entry points land here so they cannot drift
 * into asking different things about the same file.
 *
 * `Open Workspace` is the only branch that needs the file to be ours, which is
 * why the probe runs first; `Browse` and `Import data` work on any SQLite file.
 */
export async function handleDatabaseFile(api: HostApi, bridge: EasydbDbBridge, path: string, kind: EasydbDatabaseFileKind): Promise<void> {
  if (kind === 'unreadable') {
    await api.ui.dialogs.alert(`"${path}" is not a SQLite database — it could not be read.`, 'Database file');
    return;
  }

  const what = await api.ui.dialogs.choice(`What would you like to do with "${path}"?`, ['Open Workspace', 'Browse .db file', 'Import data'], 'Database file');
  if (!what) return;

  if (what === 'Import data') {
    await importFlow(api, bridge, path);
    return;
  }
  if (what === 'Browse .db file') {
    await browseFlow(api, bridge, path);
    return;
  }
  await openWorkspaceFlow(api, bridge, path, kind);
}

/**
 * Open Workspace. A file we wrote opens after the usual confirmation; a foreign
 * one cannot be opened at all (it has no workspace in it, and pointing the store
 * at it would add our bookkeeping tables to someone else's database), so the
 * offer becomes Convert or Browse.
 */
async function openWorkspaceFlow(api: HostApi, bridge: EasydbDbBridge, path: string, kind: EasydbDatabaseFileKind): Promise<void> {
  if (kind === 'foreign') {
    const choice = await api.ui.dialogs.choice(
      `"${path}" is a SQLite database, but not an easyDBAccess workspace — there is no workspace ` +
        `in it to open.\n\nIt can be converted into one (a new file is written; this one is left ` +
        `exactly as it is), or opened read-only for a look.`,
      ['Convert to EDA', 'Browse'],
      'Open workspace',
    );
    if (choice === 'Convert to EDA') await convertFlow(api, bridge, path);
    else if (choice === 'Browse') await browseFlow(api, bridge, path);
    return;
  }

  const yes = await api.ui.dialogs.confirm(
    `Open "${path}"?\n\nThis replaces the current workspace view with that file's data. ` + `Nothing is deleted — the file you have open now is left exactly as it is on disk.`,
    'Open workspace',
  );
  if (!yes) return;
  // The main process reloads this window once it has switched — nothing to
  // do with the result here, the reload re-initialises app-context.ts fresh.
  await bridge.openDbCommit(path);
}

/**
 * Convert to EDA. Which objects first — Convert used to take the whole file
 * silently, which is wrong for the same reason Import asks: a big file is mostly
 * things this workspace doesn't want, and converting them costs the time and the
 * disk. `browseList` is the enumeration to ask from, being read-only and cheap
 * (it doesn't count a view's rows).
 *
 * Then the main process asks where the converted copy goes, writes it, and
 * reloads this window onto it — so there is nothing to render here on success;
 * the reload takes over. Only a cancel returns normally.
 */
async function convertFlow(api: HostApi, bridge: EasydbDbBridge, path: string): Promise<void> {
  const objects = await bridge.browseList(path);
  if (objects.length === 0) {
    await api.ui.dialogs.alert(`"${path}" has no tables or views to convert.`, 'Convert to EDA');
    return;
  }
  const picked = await pickObjects(api, objects, 'Convert to EDA', { offerTablesOnly: true });
  if (picked.length === 0) return;

  const result = await bridge.convertDb(
    path,
    picked.map((o) => o.name),
  );
  // Nothing to report on success: the main process has already switched to the
  // new file and reloaded this window, so `resumePendingImport` — running in
  // the fresh page from the note in that file — is what speaks next.
  if (!result.ok) return; // cancelled in the save dialog
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

// -- Browse -------------------------------------------------------------------
//
// Neither opens nor imports: the file's tables AND views become read-only
// tables backed by the `sqlitefile` row source (`sqlitefile-source.ts`), so
// their rows are read from the file on demand and nothing is written — to the
// browsed file or to the workspace's own rows.

async function browseFlow(api: HostApi, bridge: EasydbDbBridge, path: string): Promise<void> {
  const workspaceId = api.workspaceId();
  if (!workspaceId) throw new Error('no active workspace');

  const objects = await bridge.browseList(path);
  if (objects.length === 0) {
    await api.ui.dialogs.alert(`"${path}" has no tables or views to browse.`, 'Browse database');
    return;
  }

  const picked = await pickObjects(api, objects, 'Browse database');
  if (picked.length === 0) return;

  const taken = new Set((await api.store.tables.find()).filter((t) => t.workspaceId === workspaceId).map((t) => t.name.toLowerCase()));

  for (const obj of picked) {
    const name = uniqueName(obj.name, taken);
    taken.add(name.toLowerCase());
    await api.store.tables.insert({
      id: crypto.randomUUID(),
      workspaceId,
      name,
      columns: obj.columns,
      view: 'table',
      // Read-only twice over: the flag stops the grid offering editors, and the
      // row source refuses every write regardless.
      readonly: true,
      source: {
        type: 'sqlitefile',
        config: { path, objectName: obj.name, isView: obj.kind === 'view' },
        writable: false,
      },
      updatedAt: Date.now(),
    } as never);
  }

  const views = picked.filter((o) => o.kind === 'view').length;
  api.ui.dialogs.toast(`Browsing ${picked.length} object${picked.length === 1 ? '' : 's'} from "${path}"` + `${views ? ` (${views} view${views === 1 ? '' : 's'})` : ''} — read-only.`, {
    kind: 'success',
    title: 'Browse database',
  });
}

/**
 * Which tables/views to act on. `Dialogs.choice` is a one-of picker, so "all"
 * versus one-at-a-time is the honest shape available — offering every object
 * individually as well keeps a single table browsable without dragging in the
 * rest of the file.
 *
 * `offerTablesOnly` adds a tables-without-the-views option, for Convert: a view
 * there is snapshotted, and snapshotting `northwind.db`'s views triples the
 * conversion (625,890 rows to 1,909,973) because several of them join its
 * 609k-row `Order Details`. Browse doesn't need it — it reads on demand.
 */
async function pickObjects(api: HostApi, objects: EasydbBrowsableObject[], title: string, opts?: { offerTablesOnly?: boolean }): Promise<EasydbBrowsableObject[]> {
  if (objects.length === 1) return objects;
  const tables = objects.filter((o) => o.kind === 'table');
  const ALL = `All ${objects.length}`;
  // Only worth offering when it differs from "All" and isn't empty.
  const TABLES = opts?.offerTablesOnly && tables.length > 0 && tables.length < objects.length ? `All ${tables.length} table${tables.length === 1 ? '' : 's'} (skip the views)` : null;
  const labels = objects.map((o) => `${o.name}${o.kind === 'view' ? ' (view)' : ''}${o.rowCount == null ? '' : ` — ${o.rowCount} rows`}`);
  const choice = await api.ui.dialogs.choice(`Which tables or views?`, [...(TABLES ? [TABLES] : []), ALL, ...labels], title);
  if (!choice) return [];
  if (choice === TABLES) return tables;
  if (choice === ALL) return objects;
  const index = labels.indexOf(choice);
  const one = objects[index];
  return one ? [one] : [];
}

// -- Import -------------------------------------------------------------------
//
// Two-phase: `bridge.importDb()` picks a file and returns a PREVIEW (table
// names, row counts, which collide with an existing table in this
// workspace) without writing anything; this flow then asks the same
// Overwrite / Rename / Skip question `datasette-connect.ts` asks for a name
// clash, once per colliding table, before calling `importDbCommit` to
// actually write.

export async function importFlow(api: HostApi, bridge: EasydbDbBridge, sourcePath?: string): Promise<void> {
  const workspaceId = api.workspaceId();
  if (!workspaceId) throw new Error('no active workspace');

  const picked = await bridge.importDb(workspaceId, sourcePath);
  if (!picked.ok) return; // cancelled in the OS dialog
  const { preview } = picked;
  if (preview.candidates.length === 0) {
    await api.ui.dialogs.alert(`No importable tables were found in "${picked.path}".`, 'Import database');
    return;
  }

  // How big the file is decides whether what the import creates opens or waits
  // minimized. Absent from an older preload; 0 reads as small.
  const sizeBytes = preview.sizeBytes ?? 0;

  // Which of them, and for a view HOW. Anything not chosen is passed to the
  // commit as an explicit `skip`, so the main process imports exactly what the
  // user picked.
  const pickedObjects = await importDeps.pickCandidates(api, preview.candidates);
  if (pickedObjects.length === 0) return;
  // A view taken as a projection is not imported at all — no rows are copied.
  // Its QUERY becomes a projection over the tables in this workspace, once they
  // exist, which is what `asProjections` below does after the import.
  const asProjections = pickedObjects.filter((p) => p.mode === 'projection');
  const chosen = pickedObjects.filter((p) => p.mode !== 'projection').map((p) => p.candidate);
  const chosenNames = new Set(chosen.map((c) => c.name));
  if (chosen.length === 0 && asProjections.length === 0) return;

  // Local table names, for proposing a unique rename target — same
  // case-insensitive rule the rest of the app uses (see `uniqueTableName` in
  // `datasette-common.ts`). Recomputed as a running set so two colliding
  // candidates in the SAME import batch can't rename to the same target.
  const takenNames = new Set((await api.store.tables.find()).filter((t) => t.workspaceId === workspaceId).map((t) => t.name.toLowerCase()));

  const decisions: Record<string, EasydbImportDecision> = {};
  for (const c of preview.candidates) {
    if (!chosenNames.has(c.name)) {
      decisions[c.name] = { action: 'skip' };
      continue;
    }
    if (!c.collides) continue;
    const choice = await api.ui.dialogs.choice(`A table named "${c.name}" already exists in this workspace.`, ['Append', 'Overwrite', 'Rename', 'Skip'], 'Import — table already exists');
    if (!choice || choice === 'Skip') {
      decisions[c.name] = { action: 'skip' };
      continue;
    }
    if (choice === 'Append') {
      const decision = await appendDecision(api, c, workspaceId);
      // A dismissed mapper means "not this table", not "append unmapped".
      decisions[c.name] = decision ?? { action: 'skip' };
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

  // Phase 1: create the chosen tables, empty and minimized. Returns in
  // milliseconds however big the file is, so the windows appear NOW.
  const { plan, skipped } = await bridge.importPrepare(picked.path, workspaceId, decisions);
  if (plan.length === 0) {
    reportImportResults(api, picked.path, skipped);
    return;
  }
  api.ui.dialogs.toast(`Importing ${plan.length} object${plan.length === 1 ? '' : 's'} from "${picked.path}" — ` + `the windows are there now and fill in as the rows arrive.`, {
    kind: 'info',
    title: 'Import database',
  });

  const sourceName = baseName(picked.path);
  const results = await runRowPhase(api, bridge, picked.path, plan, skipped, `Importing ${sourceName}${sizeBytes > 0 ? ` (${formatBytes(sizeBytes)})` : ''}`);
  reportImportResults(api, picked.path, results);
  // AFTER the rows: a projection resolves its sources by NAME, so the tables it
  // reads have to be in the workspace before it is created.
  if (asProjections.length > 0) await createViewProjections(api, workspaceId, asProjections, sizeBytes > LARGE_SOURCE_BYTES);
}

/**
 * Turn each chosen view's `CREATE VIEW … AS SELECT …` into a Projection.
 *
 * A view is a query, and this app's equivalent of a query over tables is a
 * projection — not a table of copied rows. So the view's SQL goes through the
 * same parser a `.sql` import uses (`sql-parse.ts`), and the resulting spec
 * through the same creator (`projection-create.ts`). `datasette-views.ts` does
 * exactly this for a Datasette instance; this is the same route for a local file.
 *
 * A view whose SQL the parser cannot model — an aggregate, a subquery, a window
 * function — is reported rather than half-created, with the suggestion that names
 * the alternative that does work.
 */
async function createViewProjections(api: HostApi, workspaceId: string, picked: PickedCandidate[], minimize = false): Promise<void> {
  const [{ parseSqlScript }, { createProjectionTable }] = await Promise.all([import('./sql-parse.js'), import('./projection-create.js')]);

  const created: string[] = [];
  const failed: Array<{ name: string; why: string }> = [];
  // Re-read per projection: one created here can be the source of the next, and
  // the tables the import just made have to be visible.
  for (const { candidate } of picked) {
    const sql = candidate.sql ?? '';
    if (!sql) {
      failed.push({ name: candidate.name, why: 'its definition could not be read' });
      continue;
    }
    const parsed = parseSqlScript(sql);
    const projection = parsed.projections[0];
    if (!projection) {
      failed.push({ name: candidate.name, why: parsed.unsupported[0] ?? 'its SELECT could not be modelled as a projection' });
      continue;
    }
    const pool = (await api.store.tables.find()).filter((t) => t.workspaceId === workspaceId);
    const byLower = new Map(pool.map((t) => [t.name.toLowerCase(), t] as const));
    const table = await createProjectionTable(
      api,
      workspaceId,
      { name: candidate.name, spec: projection.spec, ...(projection.sortBy ? { sortBy: projection.sortBy } : {}) },
      { resolve: (n) => byLower.get(n.toLowerCase()), taken: pool.map((t) => t.name) },
    );
    if (!table) {
      const missing = projection.spec.sources.map((src) => src.tableName).join(', ');
      failed.push({ name: candidate.name, why: `it reads tables this workspace does not have (${missing}) — import them too` });
      continue;
    }
    // A projection holds no rows of its own, so an OPEN one computes its whole
    // join before it can paint. On a big file that is the difference between a
    // workspace that appears and one that dies trying — see LARGE_SOURCE_BYTES.
    // Cascaded so restoring them does not stack them all on one spot, matching
    // what phase 1 does for the tables.
    if (minimize) {
      const n = created.length;
      await api.store.tables.patch(table.id, {
        windowGeometry: { x: 40 + (n % 10) * 24, y: 40 + (n % 10) * 24, w: 640, h: 360, z: n, minimized: true, maximized: false },
        updatedAt: Date.now(),
      });
    }
    created.push(table.name);
  }

  if (created.length > 0) {
    api.ui.dialogs.toast(
      `Created ${created.length} projection${created.length === 1 ? '' : 's'} from views: ${created.join(', ')}.${minimize ? ' Left minimized — this file is big enough that opening them all would stall the app.' : ''}`,
      {
        kind: 'success',
        title: 'Import database',
      },
    );
  }
  if (failed.length > 0) {
    api.ui.dialogs.toast(
      `${failed.length} view${failed.length === 1 ? '' : 's'} could not become a projection — ${failed.map((f) => `${f.name}: ${f.why}`).join('; ')}. Import them as Data instead.`,
      {
        kind: 'warning',
        title: 'Import database',
      },
    );
  }
}

/**
 * Phase 2: rows, one table at a time, in the background. Each table's titlebar
 * shows its own percentage (see `panel-title.ts`); the main process yields
 * between batches so the app stays usable throughout.
 *
 * Shared by Import and by the post-reload half of Convert — the two differ only
 * in how they came by the plan.
 */
async function runRowPhase(
  api: HostApi,
  bridge: EasydbDbBridge,
  sourcePath: string,
  plan: EasydbImportPlanEntry[],
  already: EasydbImportedTableResult[] = [],
  progressLabel = 'Importing',
): Promise<EasydbImportedTableResult[]> {
  const results: EasydbImportedTableResult[] = [...already];
  importInFlight = { cancelled: false };
  const token = importInFlight;
  const tracker = new ImportProgress(plan.map((e) => ({ tableId: e.tableId, total: e.total })));
  progressTracker = { tracker, label: progressLabel };
  // Indeterminate to start with: work has begun and the first batch has not
  // reported, so any number here would be invented.
  setAppProgress({ label: progressLabel, detail: `0 of ${plan.length} table${plan.length === 1 ? '' : 's'}` });
  try {
    for (const entry of plan) {
      // Checked between tables, which is the only safe place to stop: a table is
      // filled by one main-process call, and abandoning it midway would leave a
      // partly-filled table that nothing records as incomplete.
      if (token.cancelled) {
        api.ui.dialogs.toast(`Stopped. ${results.length} of ${plan.length} table${plan.length === 1 ? '' : 's'} were filled; the rest are still empty.`, {
          kind: 'warning',
          title: 'Import database',
        });
        break;
      }
      try {
        const rows = await bridge.importRows(sourcePath, entry);
        results.push({
          sourceName: entry.sourceName,
          action: entry.action,
          finalName: entry.finalName,
          tableId: entry.tableId,
          rowCount: rows,
        });
      } catch (err) {
        // One table failing must not abandon the rest — it keeps its structure
        // and the summary reports what did land.
        api.ui.dialogs.toast(`"${entry.finalName}" failed: ${(err as Error).message}`, {
          kind: 'error',
          title: 'Import database',
        });
      }
    }
  } finally {
    if (importInFlight === token) importInFlight = null;
    if (progressTracker?.tracker === tracker) progressTracker = null;
    clearAppProgress();
  }
  return results;
}

/**
 * Set while rows are being copied, so the user can stop a long import — a
 * 600k-row file takes tens of seconds and starting one must not be a
 * commitment. Null when nothing is running.
 */
let importInFlight: { cancelled: boolean } | null = null;

/** True when rows are being copied right now. */
export function isImporting(): boolean {
  return importInFlight !== null;
}

/** Asks the running import to stop after the table it is on. */
export function cancelImport(): void {
  if (importInFlight) importInFlight.cancelled = true;
}

/**
 * Offer to finish a conversion whose rows are still owed.
 *
 * Convert writes only the table structures before switching to the new file and
 * reloading the window (`db-convert.ts`'s `prepareConvert`) — a reload would
 * throw away any copying in flight, so the remaining plan is left as a note
 * inside the file instead.
 *
 * It ASKS. An earlier version just started copying, and that made the app
 * unusable: any conversion that didn't finish — the window closed, the app
 * crashed — left the note behind, so every subsequent launch immediately began
 * a minutes-long import of hundreds of thousands of rows, with no prompt, no
 * progress the user had asked for, and no way to stop it. Recovering from an
 * interruption must not itself be something you cannot get out of.
 *
 * Dismissing the prompt (Escape) leaves the note alone, so the offer returns
 * next launch; only "leave them empty" discards it.
 */
export async function resumePendingImport(api: HostApi, bridge: EasydbDbBridge): Promise<void> {
  const setting = await api.store.settings.findOne(PENDING_IMPORT_SETTING);
  const pending = setting?.value as { sourcePath?: string; plan?: EasydbImportPlanEntry[]; sizeBytes?: number } | undefined;
  if (!pending?.sourcePath || !pending.plan?.length) return;

  const tables = pending.plan.length;
  const rowsOwed = pending.plan.reduce((n, e) => n + (e.total > 0 ? e.total : 0), 0);
  const CONTINUE = 'Fill them in now';
  const DISCARD = 'Leave them empty';
  const choice = await api.ui.dialogs.choice(
    `${tables} table${tables === 1 ? '' : 's'} in this workspace ${tables === 1 ? 'is' : 'are'} still empty — ` +
      `${tables === 1 ? 'its' : 'their'} rows were being copied from "${pending.sourcePath}" when the app last ` +
      `stopped.\n\n${rowsOwed > 0 ? `About ${rowsOwed.toLocaleString()} rows are left. ` : ''}` +
      `Copying can be stopped from the Database menu once it starts.`,
    [CONTINUE, DISCARD],
    'Unfinished import',
  );
  if (choice !== CONTINUE) {
    // Only an explicit "no" throws the note away — a dismissed prompt asks again
    // next launch rather than silently abandoning the rows.
    if (choice === DISCARD) await api.store.settings.remove(PENDING_IMPORT_SETTING);
    return;
  }

  const fileName = baseName(pending.sourcePath);
  const size = pending.sizeBytes ?? 0;
  const results = await runRowPhase(api, bridge, pending.sourcePath, pending.plan, [], `Converting ${fileName}${size > 0 ? ` (${formatBytes(size)})` : ''}`);
  // Clear the note only after the rows are in, so a crash halfway offers to
  // resume rather than silently giving up. A re-run overwrites the same rows.
  await api.store.settings.remove(PENDING_IMPORT_SETTING);
  reportImportResults(api, pending.sourcePath, results);
}

/** One picked object: the candidate, plus how a view should arrive. */
interface PickedCandidate {
  candidate: EasydbImportCandidate;
  mode?: 'projection' | 'data' | undefined;
}

/**
 * Which tables and views to import, and for each view whether it arrives as a
 * projection or as data.
 *
 * A real multi-select dialog (`table-select-dialog.ts`, the one a JSON or
 * Datasette import already uses) rather than `Dialogs.choice`: choice is one-of,
 * so a big file could only be taken whole or one object at a time. Tables and
 * views get their own sections with their own all/none, because they are
 * different things — a view holds no rows of its own, and picking one means
 * choosing how it should come in.
 */
/**
 * The seam the tests replace.
 *
 * `pickCandidates` opens a Lit dialog, so it needs a DOM. The suites for this
 * module run under plain Node (there is no jsdom in this repo), and threading an
 * optional picker down through `openFlow` -> `handleDatabaseFile` -> `importFlow`
 * would put a test-only parameter on three production signatures. One overridable
 * binding is the smaller price.
 */
export const importDeps = {
  pickCandidates: (api: HostApi, candidates: EasydbImportCandidate[]): Promise<PickedCandidate[]> => pickCandidates(api, candidates),
};

async function pickCandidates(api: HostApi, candidates: EasydbImportCandidate[]): Promise<PickedCandidate[]> {
  const { chooseDatabaseObjects } = await import('../dialogs/table-select-dialog.js');
  const items = candidates.map((c) => ({
    name: c.name,
    // -1 means "not counted" (a view — counting one means running it), which the
    // dialog shows as no count rather than as "-1 rows".
    size: c.rowCount < 0 ? null : c.rowCount,
    kind: c.isView ? ('view' as const) : ('table' as const),
    ...(c.collides ? { detail: '⚠ name already in use' } : {}),
  }));
  const chosen = await chooseDatabaseObjects(items, {
    title: 'Import database',
    message: 'Tables bring their rows. A view can come in as a Projection — its query, recomputed — or as Data, a snapshot you can edit.',
    confirmLabel: 'Import',
    offerViewModes: true,
  });
  if (!chosen) return [];
  return chosen.map((c) => ({ candidate: candidates[c.index]!, mode: c.mode }));
}

/**
 * The append decision for one colliding table, asking for a column mapping only
 * when the names do not already line up.
 *
 * Append never changes the target's schema, so every source column has to land on
 * a column the target already has — or be dropped. When the names match there is
 * nothing to ask; when they do not, guessing silently is how values end up in the
 * wrong fields, so the mapper decides. It is the same dialog a CSV append uses.
 *
 * Null means the user dismissed the mapper, which the caller reads as "skip this
 * table" rather than as an append with no mapping at all.
 */
async function appendDecision(api: HostApi, candidate: EasydbImportCandidate, workspaceId: string): Promise<EasydbImportDecision | null> {
  const sourceFields = candidate.columns ?? [];
  const target = (await api.store.tables.find()).find((t) => t.workspaceId === workspaceId && t.name.toLowerCase() === candidate.name.toLowerCase());
  const targetCols = target?.columns ?? [];

  // Nothing to decide when every source column already names a target column, or
  // when either side's schema is unknown — the main process then matches by name.
  const targetFields = new Set(targetCols.map((c) => c.field.toLowerCase()));
  if (sourceFields.length === 0 || targetCols.length === 0 || sourceFields.every((f) => targetFields.has(f.toLowerCase()))) {
    return { action: 'append' };
  }

  const { mapColumnsToTable } = await import('../dialogs/column-map-dialog.js');
  const mapping = await mapColumnsToTable([...sourceFields], [...targetCols], candidate.name);
  if (!mapping) return null;
  return { action: 'append', mapping };
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
  api.ui.dialogs.toast(`Imported from "${path}": ${parts.join(', ')} (${totalRows} row${totalRows === 1 ? '' : 's'} total).`, { kind: 'success', title: 'Import database' });
}
