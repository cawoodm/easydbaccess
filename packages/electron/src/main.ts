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
import {
  getStore,
  pickDatabaseToOpen,
  switchToDatabase,
  saveDbAs,
  importDb,
  importDbCommit,
  currentDbInfo,
} from './db-files';
import type { ImportDecision } from './db-import';

const isDev = !!process.env.EASYDB_RENDERER_URL;

// -- Main-process SQLite store IPC surface ---------------------------------
//
// The store singleton itself (open/close/switch, persisted-path resolution)
// lives in `db-files.ts` — see that module's doc comment for why. This file
// only wires `ipcMain.handle` around it.

function toErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Notifies every window that a collection changed — replaces Dexie's liveQuery. */
function broadcastChanged(coll: string): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('store:changed', coll);
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

/** Same as `handle`, but also broadcasts `store:changed` for the mutated collection. */
function handleMutating<Args extends [string, ...unknown[]], R>(
  channel: string,
  fn: (...args: Args) => R,
): void {
  ipcMain.handle(channel, (_event, ...args: unknown[]) => {
    try {
      const result = fn(...(args as Args));
      broadcastChanged(args[0] as string);
      return result;
    } catch (err) {
      throw new Error(toErrorMessage(err), { cause: err });
    }
  });
}

function registerStoreIpc(): void {
  handle('store:find', (coll: string, query?: Record<string, unknown>) =>
    getStore().find(coll, query),
  );
  handle('store:findOne', (coll: string, key: string) => getStore().findOne(coll, key));
  handleMutating('store:insert', (coll: string, doc: Record<string, unknown>) =>
    getStore().insert(coll, doc),
  );
  handleMutating('store:bulkInsert', (coll: string, docs: Record<string, unknown>[]) =>
    getStore().bulkInsert(coll, docs),
  );
  handleMutating('store:upsert', (coll: string, doc: Record<string, unknown>) =>
    getStore().upsert(coll, doc),
  );
  handleMutating(
    'store:patch',
    (coll: string, key: string, patch: Record<string, unknown>) =>
      getStore().patch(coll, key, patch),
  );
  handleMutating('store:remove', (coll: string, key: string) => getStore().remove(coll, key));
  handleMutating('store:bulkRemove', (coll: string, keys: string[]) =>
    getStore().bulkRemove(coll, keys),
  );
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
  ipcMain.handle('db:import', async (event, workspaceId: unknown) => {
    try {
      return await importDb(BrowserWindow.fromWebContents(event.sender), workspaceId as string);
    } catch (err) {
      throw new Error(toErrorMessage(err), { cause: err });
    }
  });
  ipcMain.handle(
    'db:importCommit',
    (_event, sourcePath: unknown, workspaceId: unknown, decisions: unknown) => {
      try {
        const results = importDbCommit(
          sourcePath as string,
          workspaceId as string,
          decisions as Record<string, ImportDecision>,
        );
        // The import wrote new `tables` and `rows` — tell every window so
        // their subscriptions (and the new panels) pick the fresh data up,
        // same as any other mutating store call.
        broadcastChanged('tables');
        broadcastChanged('rows');
        return results;
      } catch (err) {
        throw new Error(toErrorMessage(err), { cause: err });
      }
    },
  );
  ipcMain.handle('db:current', () => currentDbInfo());
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
  'img-src \'self\' data: blob: https:; ' +
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
      dialog.showErrorBox(
        'easyDBAccess — renderer not built',
        `The renderer bundle is missing:\n  ${indexPath}\n\nBuild it first:\n  npm run build:electron`,
      );
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

    await win.loadFile(indexPath);
  }
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) void createWindow();
});

void app.whenReady().then(createWindow);
