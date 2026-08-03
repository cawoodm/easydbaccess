/**
 * Preload — bridges the renderer to main-process services via contextBridge.
 *
 * Exposes a version stamp (so the renderer can detect Electron), a `store`
 * object that proxies to the main-process `SqliteStore` over IPC (see
 * `main.ts` / `sqlite-store.ts`), and a `db` object for the user-facing file
 * operations — Open / Save As / Import (`main.ts` / `db-files.ts` /
 * `db-import.ts`). Only these specific functions are exposed — never the raw
 * `ipcRenderer` — per the security defaults this package keeps
 * (`contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`).
 *
 * `db-files.ts`/`db-import.ts` are imported here for their TYPES ONLY
 * (`import type`, erased at compile time) — never their runtime code. That
 * code calls `electron`'s `dialog`/`app`/`BrowserWindow`, which are main-
 * process-only APIs unavailable in preload's context; importing it for real
 * would silently misbehave here instead of failing typecheck.
 */

import { contextBridge, ipcRenderer } from 'electron';
import type { CurrentDbInfo, DialogResult, CancelledResult } from './db-files';
import type { ImportDecision, ImportedTableResult, ImportPreview } from './db-import';

const store = {
  find: (coll: string, query?: Record<string, unknown>): Promise<unknown[]> =>
    ipcRenderer.invoke('store:find', coll, query),
  findOne: (coll: string, key: string): Promise<unknown | null> =>
    ipcRenderer.invoke('store:findOne', coll, key),
  insert: (coll: string, doc: Record<string, unknown>): Promise<unknown> =>
    ipcRenderer.invoke('store:insert', coll, doc),
  bulkInsert: (coll: string, docs: Record<string, unknown>[]): Promise<unknown[]> =>
    ipcRenderer.invoke('store:bulkInsert', coll, docs),
  upsert: (coll: string, doc: Record<string, unknown>): Promise<unknown> =>
    ipcRenderer.invoke('store:upsert', coll, doc),
  patch: (coll: string, key: string, patch: Record<string, unknown>): Promise<unknown> =>
    ipcRenderer.invoke('store:patch', coll, key, patch),
  remove: (coll: string, key: string): Promise<void> => ipcRenderer.invoke('store:remove', coll, key),
  bulkRemove: (coll: string, keys: string[]): Promise<void> =>
    ipcRenderer.invoke('store:bulkRemove', coll, keys),
  count: (coll: string): Promise<number> => ipcRenderer.invoke('store:count', coll),
  /** Subscribes to `store:changed` broadcasts; returns an unsubscribe function. */
  onChanged: (cb: (coll: string) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, coll: string): void => cb(coll);
    ipcRenderer.on('store:changed', listener);
    return () => ipcRenderer.removeListener('store:changed', listener);
  },
  dbPath: (): Promise<string> => ipcRenderer.invoke('db:path'),
};

/**
 * File-level operations — see `db-files.ts` for the full reasoning behind
 * each. Two of these are two-phase because a collision/replace decision has
 * to be confirmed by the renderer BEFORE it happens, naming specifics (which
 * file, which colliding table) that are only known after the OS dialog
 * returns:
 *  - `openDb` picks a file (no side effects yet); `openDbCommit` does the
 *    actual switch + reload, once the renderer has confirmed "replace the
 *    workspace view with <path>?".
 *  - `importDb` picks a file and PREVIEWS it (tables + which collide);
 *    `importDbCommit` writes it, once the renderer has resolved every
 *    collision via its own Overwrite/Rename/Skip prompts.
 * This is two methods more than the brief's literal
 * `openDb()`/`saveDbAs()`/`importDb()`/`currentDb()` — see the report for why.
 */
const db = {
  openDb: (): Promise<DialogResult<{ path: string }> | CancelledResult> =>
    ipcRenderer.invoke('db:open'),
  openDbCommit: (newPath: string): Promise<{ ok: true; path: string }> =>
    ipcRenderer.invoke('db:openCommit', newPath),
  saveDbAs: (): Promise<DialogResult<{ path: string }> | CancelledResult> =>
    ipcRenderer.invoke('db:saveAs'),
  importDb: (
    workspaceId: string,
  ): Promise<DialogResult<{ path: string; preview: ImportPreview }> | CancelledResult> =>
    ipcRenderer.invoke('db:import', workspaceId),
  importDbCommit: (
    sourcePath: string,
    workspaceId: string,
    decisions: Record<string, ImportDecision>,
  ): Promise<ImportedTableResult[]> =>
    ipcRenderer.invoke('db:importCommit', sourcePath, workspaceId, decisions),
  currentDb: (): Promise<CurrentDbInfo> => ipcRenderer.invoke('db:current'),
};

contextBridge.exposeInMainWorld('easydb', {
  platform: 'electron',
  version: '0.0.3',
  store,
  db,
});

// Type augmentation for renderer code (informational — the renderer imports
// no Electron types; this lives here so it's discoverable in main.ts edits).
declare global {
  interface Window {
    easydb?: {
      platform: 'electron';
      version: string;
      store: {
        find(coll: string, query?: Record<string, unknown>): Promise<unknown[]>;
        findOne(coll: string, key: string): Promise<unknown | null>;
        insert(coll: string, doc: Record<string, unknown>): Promise<unknown>;
        bulkInsert(coll: string, docs: Record<string, unknown>[]): Promise<unknown[]>;
        upsert(coll: string, doc: Record<string, unknown>): Promise<unknown>;
        patch(coll: string, key: string, patch: Record<string, unknown>): Promise<unknown>;
        remove(coll: string, key: string): Promise<void>;
        bulkRemove(coll: string, keys: string[]): Promise<void>;
        count(coll: string): Promise<number>;
        onChanged(cb: (coll: string) => void): () => void;
        dbPath(): Promise<string>;
      };
      db: {
        openDb(): Promise<DialogResult<{ path: string }> | CancelledResult>;
        openDbCommit(newPath: string): Promise<{ ok: true; path: string }>;
        saveDbAs(): Promise<DialogResult<{ path: string }> | CancelledResult>;
        importDb(
          workspaceId: string,
        ): Promise<DialogResult<{ path: string; preview: ImportPreview }> | CancelledResult>;
        importDbCommit(
          sourcePath: string,
          workspaceId: string,
          decisions: Record<string, ImportDecision>,
        ): Promise<ImportedTableResult[]>;
        currentDb(): Promise<CurrentDbInfo>;
      };
    };
  }
}

export {};
