// packages/renderer/src/db/clone-workspace.ts
//
// Creating a workspace as a copy of another. The mirror image of
// `delete-workspace.ts`, and it delegates for the same reason: the copy spans
// five collections and has to read the SOURCE workspace's settings, which
// `DataStore.settings` — a view over the active workspace — cannot see.
//
// The work is `EdbStore.cloneWorkspace` in `packages/shared`, where rows are
// copied with one `INSERT … SELECT` per table instead of being pulled through
// JS to be re-ided.

import type { CloneMode } from '@easydb/shared';
import type { EasydbStoreBridge } from './data-store-bridge.js';

export type { CloneMode };

/**
 * Create workspace `to` and copy the requested slice of `from` into it.
 *
 * Returns the new workspace id. Caller navigates to it (`?space=`).
 */
export async function cloneWorkspace(bridge: EasydbStoreBridge, opts: { from: string; to: string; name: string; mode: CloneMode }): Promise<string> {
  if (!bridge.cloneWorkspace) throw new Error('[storage] this build cannot clone a workspace');
  return bridge.cloneWorkspace(opts);
}
