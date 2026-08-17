// packages/renderer/src/chrome/workspace-actions.ts
//
// The three things a user does to a workspace — open another one, make one,
// delete one — as flows the header selector AND the command palette both call.
// They used to live inside `workspace-selector.ts`, which meant the palette
// could not reach them and only a mouse could get at them.

import type { Dialogs } from '@easydb/shared';
import { forgetLastWorkspace, getContext, slugifyWorkspace } from '../app-context.js';
import { storeBridge } from '../db/edb/active-bridge.js';
import { cloneWorkspace, type CloneMode } from '../db/clone-workspace.js';
import { countWorkspaceContents, deleteWorkspace, describeWorkspaceContents } from '../db/delete-workspace.js';
import { EDB_EXTENSION } from '../db/edb/file-handle.js';
import { adoptEdbFile, buildEdbFile, chooseEdbTarget } from '../db/edb/new-file.js';

// The three answers of the "what should it start with?" question. Constants
// because the choice dialog reports back the label the user picked.
const CLONE_ALL = 'Clone everything (tables, views, settings)';
const CLONE_SETTINGS = 'Clone settings only (no data)';
const CLONE_NOTHING = 'Empty workspace';

// Where the new workspace's data lives. Simple is what every workspace has been
// until now; Advanced puts it in a real SQLite file the user owns.
const SIMPLE = 'Simple — in this browser (IndexedDB)';
const ADVANCED = 'Advanced — in a SQLite file you save (.edb)';

/**
 * Can this browser keep a workspace in a file?
 *
 * Needs a Web Worker for sqlite-wasm. Electron is excluded because it has its own
 * `.db` file operations, and offering two file systems in one build would be two
 * answers to one question.
 */
function canUseFileStorage(): boolean {
  return typeof Worker === 'function' && !window.easydb?.store;
}

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

/** Name a new workspace, choose where it is stored and what it inherits, then open it. */
export async function newWorkspaceFlow(): Promise<void> {
  const ctx = await getContext();
  const typed = await ctx.api.ui.dialogs.prompt('Name the new workspace. It will become active after creation.', '', 'New workspace');
  if (!typed || !typed.trim()) return;
  const name = typed.trim();

  // Asked before anything else, because the answer decides which of two entirely
  // different creation paths runs. Only asked where a file is possible at all —
  // a question with one usable answer is not a question.
  if (canUseFileStorage()) {
    const where = await ctx.api.ui.dialogs.choice(`Where should "${name}" keep its data?`, [SIMPLE, ADVANCED], 'New workspace');
    if (!where) return;
    if (where === ADVANCED) {
      await newFileWorkspace(ctx.api.ui.dialogs, name);
      return;
    }
  }

  // What the new workspace inherits. Settings are per-workspace now, so an
  // empty workspace really starts empty — it used to share this one's server
  // URL, tokens and plugin list whether you wanted that or not.
  const pick = await ctx.api.ui.dialogs.choice(`What should "${name}" start with?`, [CLONE_ALL, CLONE_SETTINGS, CLONE_NOTHING], 'New workspace');
  if (!pick) return;
  const mode: CloneMode = pick === CLONE_ALL ? 'all' : pick === CLONE_SETTINGS ? 'settings' : 'empty';

  // Create the workspace here rather than letting init() do it on first load:
  // only this side knows what to copy, and the copy must be in place before the
  // new workspace boots.
  await cloneWorkspace(storeBridge(), { from: ctx.workspaceId, to: slugifyWorkspace(name), name, mode });
  openWorkspace(name);
}

/**
 * Create a workspace that lives in its own `.edb` file, and switch this tab to it.
 *
 * The file starts EMPTY. Cloning an existing workspace into a file is the File
 * menu's "New .edb file → Copy this workspace into it", and having one job in two
 * places would mean two behaviours to keep in step.
 *
 * The reload at the end is not optional: the store is built once per load, so a
 * tab only changes where it reads from by starting again.
 */
async function newFileWorkspace(dialogs: Dialogs, name: string): Promise<void> {
  const id = slugifyWorkspace(name);
  const target = await chooseEdbTarget(dialogs, `${id}${EDB_EXTENSION}`);
  if (!target) return;
  await buildEdbFile(target, id, async (store) => {
    await store.workspaces.insert({ id, name, createdAt: Date.now(), pluginUrls: [] });
  });
  await adoptEdbFile(target);
  await dialogs.alert(`"${name}" now lives in ${target.name}. The page will reload.`, 'New workspace');
  openWorkspace(name);
}

/**
 * Delete the OPEN workspace: say what that removes, ask yes or no, remove all of it.
 *
 * The workspace is not chosen, it is the one on screen. This used to ask "delete
 * which one?" from a list of every workspace, which put a picker in front of the
 * only answer anybody wanted and made the dangerous button also the roundabout one.
 * To delete a different workspace, open it first — the header selector is beside
 * this button.
 *
 * The delete always reloads, because every open panel belongs to the workspace
 * that went: into a remaining workspace, or into a freshly created `default` when
 * it was the last one. That reload is also why there is no toast — it would be
 * thrown away with the page that shows it.
 */
export async function deleteWorkspaceFlow(): Promise<void> {
  const ctx = await getContext();
  const all = await ctx.store.workspaces.find();
  const target = all.find((w) => w.id === ctx.workspaceId);
  if (!target) return;

  const what = describeWorkspaceContents(await countWorkspaceContents(storeBridge(), target.id));
  const isLast = all.length === 1;
  const ok = await ctx.api.ui.dialogs.confirm(
    `Delete the workspace "${target.name}"?\n\n${what} will be deleted. This cannot be undone.` + (isLast ? '\n\nIt is the only workspace, so an empty one will be created in its place.' : ''),
    'Delete workspace',
  );
  if (!ok) return;

  await deleteWorkspace(storeBridge(), target.id);
  forgetLastWorkspace(target.id);

  const survivor = all.find((w) => w.id !== target.id);
  if (survivor) openWorkspace(survivor.name);
  else openResolvedWorkspace();
}
