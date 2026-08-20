// packages/renderer/src/db/delete-workspace.ts
//
// Deleting a whole workspace, and saying what that would take.
//
// The work itself is in `EdbStore` (`packages/shared`), not here: a workspace's
// contents span five collections and `DataStore.settings` is a view over the
// ACTIVE workspace, so nothing at this level can even SEE the settings of the
// workspace being deleted. That is why this module talks to the store BRIDGE
// rather than to `DataStore` — and why, under Dexie, it used to reach past the
// abstraction into the database directly.
//
// A leftover settings row would not be inert: workspace ids are slugified names,
// so creating "Demo" again re-uses the id `demo` and the new workspace would
// inherit the old one's server URL, tokens and view-seed flags.

import type { WorkspaceContents } from '@easydb/shared';
import type { EasydbStoreBridge } from './data-store-bridge.js';

export type { WorkspaceContents };

/** One noun, singular or plural. */
function plural(n: number, noun: string): string {
  return `${n.toLocaleString()} ${noun}${n === 1 ? '' : 's'}`;
}

/**
 * The contents as one phrase, for the confirm dialog and the toast that follows.
 *
 * An uncounted row total becomes "and all their rows" rather than a number this
 * side does not have. Naming the rows at all matters: tables, views and settings
 * are all a user can see in the header, and the rows are the part that hurts.
 */
export function describeWorkspaceContents(c: WorkspaceContents): string {
  const parts = [plural(c.tables, 'table')];
  if (c.rows >= 0) parts.push(plural(c.rows, 'row'));
  parts.push(plural(c.views, 'view'), plural(c.settings, 'setting'));
  const list = parts.join(', ');
  return c.rows >= 0 ? list : `${list} and all their rows`;
}

/**
 * What a delete would take with it — asked BEFORE the confirm dialog.
 *
 * `countRows` now defaults ON. Under Dexie it had to be opt-in: counting a
 * workspace holding a 609,283-row table cost 14 seconds, and a confirm dialog
 * that waits that long reads as a dead button. In SQL it is a `COUNT(*)` per
 * table, so the dialog can quote a real number again.
 */
export async function countWorkspaceContents(bridge: EasydbStoreBridge, workspaceId: string, opts: { countRows?: boolean } = {}): Promise<WorkspaceContents> {
  if (!bridge.countWorkspaceContents) throw new Error('[storage] this build cannot count a workspace');
  return bridge.countWorkspaceContents(workspaceId, { countRows: opts.countRows ?? true });
}

/**
 * Remove a workspace and everything scoped to it. Returns what went, for the
 * message the caller shows.
 *
 * Device-local `user` settings and the cached plugin bodies are deliberately
 * untouched — both are global to the device, not to a workspace (see
 * `db/user-settings.ts`). What did belong to this workspace is its `pluginUrls`,
 * which is a field ON the workspace record and goes with it.
 */
export async function deleteWorkspace(bridge: EasydbStoreBridge, workspaceId: string): Promise<WorkspaceContents> {
  if (!bridge.deleteWorkspace) throw new Error('[storage] this build cannot delete a workspace');
  return bridge.deleteWorkspace(workspaceId);
}
