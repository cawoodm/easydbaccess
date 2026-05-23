/**
 * The backend's entire job: store one JSON document per workspace.
 * Push uploads it. Pull downloads it. The client decides the document shape
 * and how to merge concurrent edits; the server only enforces etag-based
 * concurrency. Adding a new backend means implementing just this interface —
 * see fs-store.ts and sqlite-store.ts as references.
 */

export type Json =
  | null
  | boolean
  | number
  | string
  | Json[]
  | { [key: string]: Json };

export type Unsubscribe = () => void;

export type WriteResult =
  | { ok: true; etag: string }
  | { ok: false; conflict: true; currentEtag: string };

export interface StoreAdapter {
  /** Read the workspace document. body is null if the workspace has never been written. */
  read(workspaceId: string): Promise<{ body: Json | null; etag: string | null }>;

  /**
   * Write the workspace document.
   * - If opts.ifMatchEtag is a string, the write succeeds only if the current etag matches.
   *   On mismatch, returns { ok: false, conflict: true, currentEtag } and the store is unchanged.
   * - If opts.ifMatchEtag is null, the write is unconditional (overwrite).
   */
  write(
    workspaceId: string,
    body: Json,
    opts: { ifMatchEtag: string | null },
  ): Promise<WriteResult>;

  /** Notify when a workspace document changes. Optional — clients can poll if absent. */
  watch?(workspaceId: string, fn: () => void): Unsubscribe;

  /** Enumerate known workspace IDs. Optional but useful for discovery. */
  list?(): Promise<string[]>;

  /** Release any resources (e.g. SQLite file handle). */
  close?(): Promise<void> | void;
}
