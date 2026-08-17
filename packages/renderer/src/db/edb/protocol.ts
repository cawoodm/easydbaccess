import type { CloneMode, DistinctQuery, RowQuery } from '@easydb/shared';

/**
 * The worker protocol.
 *
 * Deliberately mirrors `EasydbStoreBridge` — the interface Electron's preload
 * already satisfies — so the main thread can reuse `createIpcDataStore`
 * unchanged instead of growing a second `DataStore` adapter. One async bridge
 * shape, two transports: `ipcRenderer` on the desktop, `postMessage` here.
 */

/** A call the main thread makes into the worker. */
export type EdbRequest =
  | { id: number; op: 'open'; bytes: Uint8Array | null; name: string }
  /**
   * Put a database into the substrate under `name`, WITHOUT switching to it.
   *
   * What Open and Convert need. Both produce the bytes of a file this tab is
   * about to adopt, and adopting is a reload — so the bytes have to be where the
   * next boot will look before the reload happens. They cannot be placed by a
   * throwaway worker: the `opfs-sahpool` VFS is exclusive origin-wide, so a
   * second worker never gets the pool and writes its copy somewhere the boot
   * does not read.
   */
  | { id: number; op: 'importBytes'; name: string; bytes: Uint8Array }
  /** The OPFS mirror's bytes for a workspace, if it has any. Needs no file permission. */
  | { id: number; op: 'restore'; name: string }
  | { id: number; op: 'find'; coll: string; query?: Record<string, unknown> | undefined; limit?: number | undefined }
  | { id: number; op: 'findOne'; coll: string; key: string }
  | { id: number; op: 'insert'; coll: string; doc: Record<string, unknown> }
  | { id: number; op: 'bulkInsert'; coll: string; docs: Record<string, unknown>[] }
  | { id: number; op: 'upsert'; coll: string; doc: Record<string, unknown> }
  | { id: number; op: 'patch'; coll: string; key: string; patch: Record<string, unknown> }
  | { id: number; op: 'remove'; coll: string; key: string }
  | { id: number; op: 'bulkRemove'; coll: string; keys: string[] }
  | { id: number; op: 'count'; coll: string }
  | { id: number; op: 'countRows'; tableId: string }
  | { id: number; op: 'queryRows'; tableId: string; query: RowQuery }
  | { id: number; op: 'distinctValues'; tableId: string; query: DistinctQuery }
  /**
   * One arbitrary SQL statement. Read-only unless `write` is set — the worker
   * enforces that through SQLite, not by inspecting the statement.
   */
  | { id: number; op: 'runSql'; sql: string; params?: unknown[] | undefined; write?: boolean | undefined; maxRows?: number | undefined }
  /**
   * Whole-workspace operations, which `DataStore` cannot express: its `settings`
   * view is scoped to the ACTIVE workspace, so nothing above the store can see
   * another workspace's settings to copy or delete them.
   */
  | { id: number; op: 'countWorkspaceContents'; workspaceId: string; countRows?: boolean | undefined }
  | { id: number; op: 'deleteWorkspace'; workspaceId: string }
  | { id: number; op: 'cloneWorkspace'; from: string; to: string; name: string; mode: CloneMode }
  | { id: number; op: 'export' }
  /**
   * Write the OPFS mirror NOW, without waiting for the debounce.
   *
   * What makes Open and Convert work. Both put bytes into a worker and then
   * reload the page, and the boot after that reload reads the mirror — never the
   * user's file, which would need a permission gesture no boot has. Without a
   * forced write the reload would find no mirror and start empty.
   */
  | { id: number; op: 'flush' }
  | { id: number; op: 'dbName' };

/** What comes back. A `changed` message is unsolicited and carries no id. */
export type EdbResponse =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: string }
  /**
   * Broadcast after a write, so a collection can re-run its own query. `scope`
   * narrows a row change to one table so unrelated row views stay put — the same
   * contract `store:changed` has on the Electron side.
   */
  | { changed: string; scope?: string | undefined }
  /**
   * Something went wrong that the user should hear about but that did not fail
   * the call — a mirror write that could not complete, say. Not `console`: a
   * warning about data safety belongs in front of the user, and this repo treats
   * a stray console statement as an error.
   */
  | { warning: string };

/**
 * `ROW_COLLECTION` used to live here. It is now in `@easydb/shared`
 * (`change-scope.ts`), beside the rule that reads it, so the two cannot drift.
 */

/**
 * One request minus the id the bridge assigns.
 *
 * Written to DISTRIBUTE over the union: a plain `Omit<EdbRequest, 'id'>` collapses
 * to the keys every member shares, which is just `op`, and then rejects `coll`
 * on every call site.
 */
export type EdbCall<T = EdbRequest> = T extends { id: number } ? Omit<T, 'id'> : never;
