/**
 * Electron main process entry point.
 *
 * A BrowserWindow that loads the Vite-served renderer in dev (via
 * EASYDB_RENDERER_URL) or the built renderer in production. Unlike the browser
 * build, this renderer stores its data in the main-process SQLite file rather
 * than Dexie/IndexedDB — see `renderer/src/app-context.ts` for where it picks.
 *
 * This file wires up the main-process SQLite store's IPC surface: the
 * `store:*` / `db:path` channels (data access, `sqlite-store.ts`) and the
 * `db:open` / `db:openCommit` / `db:saveAs` / `db:import` / `db:importCommit`
 * / `db:current` channels (file operations, `db-files.ts` / `db-import.ts`)
 * so `preload.ts` can expose them to the renderer.
 */

import { app, BrowserWindow, dialog, session, ipcMain } from 'electron';
import * as path from 'node:path';
import { existsSync } from 'node:fs';
import { getStore, pickDatabaseToOpen, switchToDatabase, saveDbAs, importDb, importDbCommit, convertAndOpen, currentDbInfo, autoLoadLastWorkspace, setAutoLoadLastWorkspace } from './db-files';
import { prepareImport, probeDatabaseFile, type ImportPlanEntry } from './db-import';
import { runImport } from './import-runner';
import { listBrowsable, readBrowseRows } from './db-browse';
import { ALL_COLLECTIONS, changeScopeOf, type ColumnSpec, type RowQuery, type SqlRunOptions } from '@easydb/shared';
import type { ImportDecision } from './db-import';

const isDev = !!process.env.EASYDB_RENDERER_URL;

/**
 * Opt-in `?test=1` on the renderer, for the desktop e2e suite.
 *
 * `?test=1` is what makes `renderer/src/main.ts` publish the live `AppContext`
 * on `window.__easydb`, and the specs drive the app through it — the same hook
 * the browser suite uses. It has to be on the FIRST load: navigating a second
 * time to add the query would boot the app twice, and the first boot already
 * creates a workspace in the file under test.
 *
 * Off unless asked for, like `EASYDB_DEVTOOLS_PORT` below.
 */
const isE2E = process.env.EASYDB_E2E === '1';

// -- Main-process SQLite store IPC surface ---------------------------------
//
// The store singleton itself (open/close/switch, persisted-path resolution)
// lives in `db-files.ts` — see that module's doc comment for why. This file
// only wires `ipcMain.handle` around it.

function toErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Notifies every window that a collection changed — replaces Dexie's liveQuery.
 *
 * `scope` narrows it to ONE table's rows. Without it, every subscribed
 * `rows(tableId)` view re-reads its whole result set, which is quadratic during
 * a multi-table import: finishing each of `northwind.db`'s 13 tables made all 13
 * panels re-fetch, and one of them holds 609k rows. An unscoped broadcast still
 * refreshes everything, which is what every ordinary write wants.
 */
function broadcastChanged(coll: string, scope?: string): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('store:changed', coll, scope);
  }
}

/**
 * Wraps a handler so a thrown error becomes a rejected promise with a
 * readable message, instead of ever taking down the main process.
 */
function handle<Args extends unknown[], R>(channel: string, fn: (...args: Args) => R): void {
  ipcMain.handle(channel, (_event, ...args: unknown[]) => {
    try {
      return fn(...(args as Args));
    } catch (err) {
      throw new Error(toErrorMessage(err), { cause: err });
    }
  });
}

/**
 * Same as `handle`, but also broadcasts `store:changed` for the mutated
 * collection.
 *
 * The scope comes from what the store RETURNED, by the same rule the browser
 * worker uses (`changeScopeOf` in `@easydb/shared`) — the request cannot supply
 * it for a remove, a bulk remove or a patch. Until this was wired the desktop
 * broadcast every row write unscoped, which is the quadratic case
 * `broadcastChanged` describes.
 */
function handleMutating<Args extends [string, ...unknown[]], R>(channel: string, fn: (...args: Args) => R): void {
  ipcMain.handle(channel, (_event, ...args: unknown[]) => {
    try {
      const result = fn(...(args as Args));
      const coll = args[0] as string;
      broadcastChanged(coll, changeScopeOf(coll, result));
      return result;
    } catch (err) {
      throw new Error(toErrorMessage(err), { cause: err });
    }
  });
}

function registerStoreIpc(): void {
  handle('store:find', (coll: string, query?: Record<string, unknown>, limit?: number) => getStore().find(coll, query, limit));
  // Paired with a capped `store:find`, so a grid can say "20,000 of 609,283"
  // instead of silently presenting a truncated table as the whole thing.
  handle('store:countRows', (tableId: string) => getStore().countRowsIn(tableId));
  // The narrow read: the caller says which fields, filter, sort and slice it
  // wants and only that crosses IPC. `store:find` above hands over up to
  // ROW_FETCH_CAP rows whatever the caller intends to show.
  handle('store:queryRows', (tableId: string, q: RowQuery) => getStore().queryRows(tableId, q));
  // One column's distinct values, counted in SQL. A funnel's value list at any
  // table size, with no row crossing IPC.
  handle('store:distinctValues', (tableId: string, q: { field: string; where?: RowQuery; limit?: number }) => getStore().distinctValues(tableId, q));
  handle('store:findOne', (coll: string, key: string) => getStore().findOne(coll, key));
  handleMutating('store:insert', (coll: string, doc: Record<string, unknown>) => getStore().insert(coll, doc));
  handleMutating('store:bulkInsert', (coll: string, docs: Record<string, unknown>[]) => getStore().bulkInsert(coll, docs));
  handleMutating('store:upsert', (coll: string, doc: Record<string, unknown>) => getStore().upsert(coll, doc));
  handleMutating('store:patch', (coll: string, key: string, patch: Record<string, unknown>) => getStore().patch(coll, key, patch));
  handleMutating('store:remove', (coll: string, key: string) => getStore().remove(coll, key));
  handleMutating('store:bulkRemove', (coll: string, keys: string[]) => getStore().bulkRemove(coll, keys));
  // Raw SQL. Not `handleMutating`: that reads args[0] as the collection, which
  // here is the statement text. A write also cannot say what it touched, so it
  // announces every collection rather than leaving a stale panel on screen.
  handle('store:runSql', (sql: string, opts?: SqlRunOptions) => {
    const result = getStore().runSql(sql, opts);
    if (opts?.write) for (const coll of ALL_COLLECTIONS) broadcastChanged(coll);
    return result;
  });
  handle('store:count', (coll: string) => getStore().count(coll));
  handle('db:path', () => getStore().filePath);
}

registerStoreIpc();

/**
 * File-level operations: Open / Save As / Import (two-phase — see
 * `db-files.ts` / `db-import.ts`). These need the invoking `BrowserWindow`
 * (for the dialog's parent and, for Open, to reload it), which `handle()`'s
 * generic wrapper above doesn't thread through — so these register directly
 * against `ipcMain`, with the same try/catch-and-rethrow shape as `handle()`.
 */
function registerDbFileIpc(): void {
  ipcMain.handle('db:open', async (event) => {
    try {
      return await pickDatabaseToOpen(BrowserWindow.fromWebContents(event.sender));
    } catch (err) {
      throw new Error(toErrorMessage(err), { cause: err });
    }
  });
  ipcMain.handle('db:openCommit', (event, newPath: unknown) => {
    try {
      return switchToDatabase(BrowserWindow.fromWebContents(event.sender), newPath as string);
    } catch (err) {
      throw new Error(toErrorMessage(err), { cause: err });
    }
  });
  ipcMain.handle('db:saveAs', async (event) => {
    try {
      return await saveDbAs(BrowserWindow.fromWebContents(event.sender));
    } catch (err) {
      throw new Error(toErrorMessage(err), { cause: err });
    }
  });
  ipcMain.handle('db:import', async (event, workspaceId: unknown, sourcePath: unknown) => {
    try {
      return await importDb(BrowserWindow.fromWebContents(event.sender), workspaceId as string, typeof sourcePath === 'string' ? sourcePath : undefined);
    } catch (err) {
      throw new Error(toErrorMessage(err), { cause: err });
    }
  });
  ipcMain.handle('db:importCommit', (_event, sourcePath: unknown, workspaceId: unknown, decisions: unknown) => {
    try {
      const results = importDbCommit(sourcePath as string, workspaceId as string, decisions as Record<string, ImportDecision>);
      // The import wrote new `tables` and `rows` — tell every window so
      // their subscriptions (and the new panels) pick the fresh data up,
      // same as any other mutating store call.
      broadcastChanged('tables');
      broadcastChanged('rows');
      return results;
    } catch (err) {
      throw new Error(toErrorMessage(err), { cause: err });
    }
  });
  ipcMain.handle('db:convert', async (event, sourcePath: unknown, only: unknown) => {
    try {
      return await convertAndOpen(BrowserWindow.fromWebContents(event.sender), sourcePath as string, only as string[] | undefined);
    } catch (err) {
      throw new Error(toErrorMessage(err), { cause: err });
    }
  });
  // A dropped file arrives with a path the renderer already has (via
  // `webUtils.getPathForFile`), so there is no picker to run — only the
  // read-only classification Open needs before it offers anything.
  handle('db:probe', (sourcePath: string) => probeDatabaseFile(sourcePath));

  // Phase 1 of an import: create the chosen tables, empty. Cheap at any file
  // size, so the windows appear at once instead of after the data.
  ipcMain.handle('db:importPrepare', (_event, sourcePath: unknown, workspaceId: unknown, decisions: unknown) => {
    try {
      const result = prepareImport(sourcePath as string, getStore(), workspaceId as string, decisions as Record<string, ImportDecision>);
      broadcastChanged('tables'); // opens the (minimized, empty) windows
      return result;
    } catch (err) {
      throw new Error(toErrorMessage(err), { cause: err });
    }
  });

  /**
   * Phase 2: one table's rows, on a worker thread.
   *
   * `import-runner.ts` decides between the worker and this thread — the worker
   * needs WAL to write the file alongside the open connection, and a file that
   * refused WAL falls back to the in-process loop. Either way this handler only
   * relays progress, so it never blocks on the copy itself.
   */
  ipcMain.handle('db:importRows', async (event, sourcePath: unknown, entry: unknown) => {
    const store = getStore();
    const plan = entry as ImportPlanEntry;
    try {
      const rows = await runImport(sourcePath as string, store, plan, {
        onProgress: (p) => event.sender.send('import:progress', { tableId: plan.tableId, ...p }),
      });
      // One broadcast at the end, not per batch: a grid that re-read on every
      // batch would spend the import re-rendering instead of importing. Scoped
      // to this table, so the other twelve panels don't re-read too.
      broadcastChanged('rows', plan.tableId);
      event.sender.send('import:progress', {
        tableId: plan.tableId,
        table: plan.finalName,
        rows,
        total: plan.total,
        done: true,
      });
      return rows;
    } catch (err) {
      throw new Error(toErrorMessage(err), { cause: err });
    }
  });
  // Browse reads a file we neither opened nor imported — always read-only, so
  // these two need no confirmation step and no `broadcastChanged`.
  handle('db:browseList', (sourcePath: string) => listBrowsable(sourcePath));
  handle('db:browseRows', (sourcePath: string, objectName: string, columns: ColumnSpec[]) => readBrowseRows(sourcePath, objectName, columns));
  ipcMain.handle('db:current', () => currentDbInfo());
  // Startup behaviour, not a workspace setting: it is read before any workspace
  // is open, so it cannot live in the file whose opening it governs.
  handle('db:autoLoadLast', () => autoLoadLastWorkspace());
  handle('db:setAutoLoadLast', (on: boolean) => setAutoLoadLastWorkspace(on));
}

registerDbFileIpc();

// Content-Security-Policy applied only to the packaged/file:// production
// load. The Vite dev server injects its own dev-time script handling (HMR
// websocket, eval'd module shims) that this policy would break, so it is
// wired up only in the production branch below.
//
// Directive-by-directive rationale:
// - `default-src 'self'`: baseline — only load same-origin (file://) resources.
// - `script-src 'self' 'unsafe-eval'`: `'unsafe-eval'` is REQUIRED because
//   packages/renderer/src/util/column-script.ts uses `new Function(...)` to
//   run user-authored per-column scripts. Removing `unsafe-eval` would break
//   that feature. Note this also means Electron's "Insecure Content-Security-Policy"
//   dev-time console warning still fires — the warning triggers on any policy
//   that grants `unsafe-eval`, and it cannot be silenced without dropping the
//   column-script feature.
// - `style-src 'self' 'unsafe-inline'`: packages/renderer/index.html ships an
//   inline `<style>` block, which needs `unsafe-inline` to run.
// - `img-src 'self' data: blob: https:'`: `https:` lets the image cell
//   renderer show remote images; `data:`/`blob:` cover the favicon and
//   generated (e.g. canvas-exported) images.
// - `font-src 'self' data:`: covers any inlined/data-URI fonts.
// - `connect-src 'self' http: https:`: `api.backend.fetch` needs to reach
//   arbitrary Datasette instances, Gist, or a self-hosted sync server, which
//   are not known in advance.
const PRODUCTION_CSP =
  "default-src 'self'; " +
  "script-src 'self' 'unsafe-eval'; " +
  "style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data: blob: https:; " +
  "font-src 'self' data:; " +
  "connect-src 'self' http: https:";

function resolveFrontendIndexPath(): string {
  return path.join(__dirname, '../frontend/index.html');
}

async function createWindow(): Promise<void> {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    title: 'easyDBAccess',
    backgroundColor: '#f3f4f6',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  if (isDev) {
    const url = process.env.EASYDB_RENDERER_URL!;
    await win.loadURL(url);
    win.webContents.openDevTools({ mode: 'detach' });
  } else {
    // Built renderer lives at packages/electron/frontend/index.html, produced
    // by `npm run build:electron --workspace @easydb/renderer` (base=./).
    // Kept separate from packages/renderer/dist/ so the gh-pages build
    // (--base /easydbaccess/) doesn't collide with the file:// build.
    const indexPath = resolveFrontendIndexPath();
    if (!existsSync(indexPath)) {
      dialog.showErrorBox('easyDBAccess — renderer not built', `The renderer bundle is missing:\n  ${indexPath}\n\nBuild it first:\n  npm run build:electron`);
      app.quit();
      return;
    }

    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          'Content-Security-Policy': [PRODUCTION_CSP],
        },
      });
    });

    await win.loadFile(indexPath, isE2E ? { query: { test: '1' } } : {});
  }
}

/**
 * Opt-in CDP endpoint, for measuring the app rather than guessing about it.
 *
 * Some questions can only be answered against the running app — "is the UI
 * responsive while a 600k-row import runs" is one, since it depends on how the
 * renderer, the IPC and the synchronous SQLite writes interleave. With this set,
 * a Playwright/CDP client can attach and drive `window.easydb` directly, which
 * also sidesteps the native file dialogs a scripted test cannot click.
 *
 * Off unless asked for: it opens an unauthenticated debugging port.
 */
if (process.env.EASYDB_DEVTOOLS_PORT) {
  app.commandLine.appendSwitch('remote-debugging-port', process.env.EASYDB_DEVTOOLS_PORT);
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) void createWindow();
});

void app.whenReady().then(createWindow);
