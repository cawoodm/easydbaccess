// packages/renderer/src/chrome/workspace-actions.ts
//
// The three things a user does to a workspace — open another one, make one,
// delete one — as flows the header selector AND the command palette both call.
// They used to live inside `workspace-selector.ts`, which meant the palette
// could not reach them and only a mouse could get at them.

import { forgetLastWorkspace, getContext, slugifyWorkspace } from '../app-context.js';
import { getDb } from '../db/index.js';
import { cloneWorkspace, type CloneMode } from '../db/clone-workspace.js';
import { countWorkspaceContents, deleteWorkspace } from '../db/delete-workspace.js';

// The three answers of the "what should it start with?" question. Constants
// because the choice dialog reports back the label the user picked.
const CLONE_ALL = 'Clone everything (tables, views, settings)';
const CLONE_SETTINGS = 'Clone settings only (no data)';
const CLONE_NOTHING = 'Empty workspace';

/**
 * Open a workspace by RELOADING with `?space=<name>`. A reload is the cleanest
 * cut: Dexie collections, panel windows and the plugin host all bind to one
 * workspaceId at boot, so swapping it live would mean tearing down every panel
 * and rebinding every subscription.
 */
export function openWorkspace(name: string): void {
  const sp = new URLSearchParams(location.search);
  sp.set('space', name);
  location.assign(`${location.pathname}?${sp.toString()}${location.hash}`);
}

/** Reload with no `?space=`, letting boot resolve which workspace to open. */
function openResolvedWorkspace(): void {
  const sp = new URLSearchParams(location.search);
  sp.delete('space');
  const query = sp.toString();
  location.assign(`${location.pathname}${query ? `?${query}` : ''}${location.hash}`);
}

/** Ask which workspace to switch to, then open it. */
export async function switchWorkspaceFlow(): Promise<void> {
  const ctx = await getContext();
  const others = (await ctx.store.workspaces.find()).filter((w) => w.id !== ctx.workspaceId);
  if (others.length === 0) {
    ctx.api.ui.dialogs.toast('This is the only workspace.', { kind: 'info', title: 'Workspaces' });
    return;
  }
  const pick = await ctx.api.ui.dialogs.choice(
    'Open which workspace?',
    others.map((w) => w.name),
    'Switch workspace',
  );
  if (!pick) return;
  openWorkspace(pick);
}

/** Name a new workspace, choose what it inherits, create it and open it. */
export async function newWorkspaceFlow(): Promise<void> {
  const ctx = await getContext();
  const name = await ctx.api.ui.dialogs.prompt('Name the new workspace. It will become active after creation.', '', 'New workspace');
  if (!name || !name.trim()) return;

  // What the new workspace inherits. Settings are per-workspace now, so an
  // empty workspace really starts empty — it used to share this one's server
  // URL, tokens and plugin list whether you wanted that or not.
  const pick = await ctx.api.ui.dialogs.choice(`What should "${name.trim()}" start with?`, [CLONE_ALL, CLONE_SETTINGS, CLONE_NOTHING], 'New workspace');
  if (!pick) return;
  const mode: CloneMode = pick === CLONE_ALL ? 'all' : pick === CLONE_SETTINGS ? 'settings' : 'empty';

  // Create the workspace here rather than letting init() do it on first load:
  // only this side knows what to copy, and the copy must be in place before the
  // new workspace boots.
  await cloneWorkspace(getDb(), { from: ctx.workspaceId, to: slugifyWorkspace(name.trim()), name: name.trim(), mode });
  openWorkspace(name.trim());
}

/**
 * Ask which workspace to delete, say what that removes, and remove all of it.
 *
 * Deleting the ACTIVE workspace reloads — every open panel belongs to it — into
 * a remaining workspace, or into a freshly created `default` when it was the
 * last one. Deleting any other workspace is silent apart from the toast, because
 * nothing on screen belongs to it.
 */
export async function deleteWorkspaceFlow(): Promise<void> {
  const ctx = await getContext();
  const all = await ctx.store.workspaces.find();

  let target = all.find((w) => w.id === ctx.workspaceId) ?? all[0];
  if (!target) return;
  if (all.length > 1) {
    const pick = await ctx.api.ui.dialogs.choice(
      'Delete which workspace? Everything in it goes with it.',
      all.map((w) => w.name),
      'Delete workspace',
    );
    if (!pick) return;
    target = all.find((w) => w.name === pick) ?? target;
  }

  const counts = await countWorkspaceContents(getDb(), target.id);
  const what = [
    `${counts.tables} table${counts.tables === 1 ? '' : 's'}`,
    `${counts.rows.toLocaleString()} row${counts.rows === 1 ? '' : 's'}`,
    `${counts.views} view${counts.views === 1 ? '' : 's'}`,
    `${counts.settings} setting${counts.settings === 1 ? '' : 's'}`,
  ].join(', ');
  const isLast = all.length === 1;
  const ok = await ctx.api.ui.dialogs.confirm(
    `Delete the workspace "${target.name}"?\n\n${what} will be deleted. This cannot be undone.` +
      (isLast ? '\n\nIt is the only workspace, so an empty one will be created in its place.' : ''),
    'Delete workspace',
  );
  if (!ok) return;

  await deleteWorkspace(getDb(), target.id);
  forgetLastWorkspace(target.id);

  if (target.id !== ctx.workspaceId) {
    ctx.api.ui.dialogs.toast(`Deleted "${target.name}" (${what}).`, { kind: 'success', title: 'Workspace deleted' });
    return;
  }
  // The active workspace went: everything on screen belongs to it, so reload.
  const survivor = all.find((w) => w.id !== target.id);
  if (survivor) openWorkspace(survivor.name);
  else openResolvedWorkspace();
}
