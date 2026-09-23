// packages/renderer/src/chrome/workspace-actions.ts
//
// The three things a user does to a workspace — open another one, make one,
// delete one — as flows the header selector AND the command palette both call.
// They used to live inside `workspace-selector.ts`, which meant the palette
// could not reach them and only a mouse could get at them.

import type { Dialogs } from '@easydb/shared';
import { forgetLastWorkspace, getContext, slugifyWorkspace } from '../app-context.js';
import { workspaceLabel, type ListEntry } from '../db/edb/folder-index.js';
import { openWorkspaceInFile } from '../db/edb/space-adopt.js';
import { storeBridge } from '../db/edb/active-bridge.js';
import { cloneWorkspace, type CloneMode } from '../db/clone-workspace.js';
import { countWorkspaceContents, deleteWorkspace, describeWorkspaceContents } from '../db/delete-workspace.js';
import { EDB_EXTENSION } from '../db/edb/file-handle.js';
import { fileWorkspaceBackend } from '../db/file-workspaces.js';
import { adoptEdbFile, buildEdbFile, edbTargetNamed } from '../db/edb/new-file.js';

// The three answers of the "what should it start with?" question. Constants
// because the choice dialog reports back the label the user picked.
const CLONE_ALL = 'Clone everything (tables, views, settings)';
const CLONE_SETTINGS = 'Clone settings only (no data)';
const CLONE_NOTHING = 'Empty workspace';

// Where the new workspace's data lives. Simple puts it beside the one open now;
// Advanced gives it a `.edb` of its own.
//
// Neither label names a storage engine or a platform, and both used to. "Simple
// — in this browser" was wrong twice over: it was written when that meant
// IndexedDB, which this app dropped in v0.0.383, and it reads as a lie in the
// desktop build, which offers the same two choices since v0.0.491. What the user
// is actually choosing is whether the new workspace shares a file with this one.
const SIMPLE = 'Simple — alongside this workspace';
const ADVANCED = 'Advanced — in a file of its own (.edb)';

/**
 * Can this build keep a workspace in a file of its own?
 *
 * Two ways to say yes. A build that installed a {@link FileWorkspaceBackend}
 * answers for itself — that is the desktop, once a workspace folder is
 * connected. Otherwise it is the browser's own route, which needs a Web Worker
 * for sqlite-wasm.
 *
 * The desktop used to be excluded outright, on the grounds that it had its own
 * `.db` file commands. It no longer has a separate set: both builds reach files
 * through Connect ▸ Local Data, so both offer the same New workspace question.
 */
async function canUseFileStorage(): Promise<boolean> {
  const backend = fileWorkspaceBackend();
  if (backend) return backend.canCreate();
  return typeof Worker === 'function' && !window.easydb?.store;
}

/**
 * Open a workspace by RELOADING with `?space=<name>`. A reload is the cleanest
 * cut: the store's collections, panel windows and the plugin host all bind to
 * one workspaceId at boot, so swapping it live would mean tearing down every
 * panel and rebinding every subscription.
 */
export function openWorkspace(name: string): void {
  const sp = new URLSearchParams(location.search);
  sp.set('space', name);
  location.assign(`${location.pathname}?${sp.toString()}${location.hash}`);
}

/**
 * Open one entry of the workspace selector's list, wherever it lives.
 *
 * The list merges two things that look alike and route differently: the
 * workspaces in the database this tab has open, and the ones the connected folder
 * holds in OTHER files. Only the first can go through `?space=`.
 *
 * For the second, the FILE is the identity — `openWorkspace(entry.name)` threw it
 * away and left boot to derive a file from the name, so two files holding a
 * workspace called `simon` were one destination and the list's own file tooltip
 * was the only thing that had ever told them apart. Same reason the open-database
 * side switches on `id` rather than `name`: a name is not unique either
 * (`freeWorkspaceId` mints `sales-2` beside `sales`, both still called `sales`).
 */
export async function openListEntry(entry: ListEntry): Promise<void> {
  if (!entry.file) {
    openWorkspace(entry.id);
    return;
  }
  const ctx = await getContext();
  // A build with its own way of reaching files answers first. On the desktop that
  // is the main process switching the store to another path and reloading the
  // window — there is no handle to adopt and no `?space=` to write. See
  // `db/file-workspaces.ts`.
  const backend = fileWorkspaceBackend();
  if (backend) {
    if ((await backend.open(entry.file, entry.id)) !== 'unavailable') return;
    ctx.api.ui.dialogs.toast(`${entry.file} could not be opened. Check the folder under Connect ▸ Local Data.`, { kind: 'warning', title: 'Switch workspace' });
    return;
  }
  // The dialogs go in because the switch may have a question to ask: this browser
  // and the file can each hold a copy of that workspace, and nothing in the
  // storage layer may pick one of them on the user's behalf. See
  // `db/edb/copy-choice.ts`.
  const outcome = await openWorkspaceInFile(entry.file, entry.id, ctx.api.ui.dialogs);
  // A cancelled question is an answer, not a failure: the user just said to leave
  // both copies alone, and a warning about it would read as a fault.
  if (outcome !== 'unavailable') return;
  // The index is a cache: the file may have been moved, renamed, or the folder
  // grant let go since the last scan. Say which file, because that is the part
  // the user can act on.
  ctx.api.ui.dialogs.toast(`${entry.file} could not be opened. Reconnect the folder under Connect ▸ Local Data.`, { kind: 'warning', title: 'Switch workspace' });
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
  // Titles, like the header selector — the same list of the same things must not
  // be spelled two ways. The pick comes back as a LABEL, so it is mapped to the
  // name `?space=` routes on; two workspaces may even carry the same title, and
  // the first match is as good an answer as a list of identical labels allows.
  const pick = await ctx.api.ui.dialogs.choice('Open which workspace?', others.map(workspaceLabel), 'Switch workspace');
  if (!pick) return;
  const chosen = others.find((w) => workspaceLabel(w) === pick);
  // By id, not by name: two workspaces in one database may share a name
  // (`freeWorkspaceId` puts `sales-2` beside `sales` and both stay called
  // `sales`), and `?space=` would then resolve to whichever came first.
  if (chosen) openWorkspace(chosen.id);
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
  if (await canUseFileStorage()) {
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
 * The file starts EMPTY, and its name is the workspace's own (`<id>.edb`) — the
 * same convention Save writes under and Open reads back. To get a COPY of this
 * workspace in a file, take the Simple path with "Clone everything" and then Save:
 * that writes the clone into the folder under its own name.
 *
 * The reload at the end is not optional: the store is built once per load, so a
 * tab only changes where it reads from by starting again.
 */
async function newFileWorkspace(dialogs: Dialogs, name: string): Promise<void> {
  const id = slugifyWorkspace(name);
  // Same split as `openListEntry`: a build that owns its own file access does
  // this itself. The desktop writes the `.edb` into the connected folder and
  // switches the store to it, which ends in a reload, so nothing after this runs.
  const backend = fileWorkspaceBackend();
  if (backend) {
    await backend.create(name, id);
    return;
  }
  const target = await edbTargetNamed(dialogs, `${id}${EDB_EXTENSION}`);
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
