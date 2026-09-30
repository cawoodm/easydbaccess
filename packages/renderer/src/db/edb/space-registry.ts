// packages/renderer/src/db/edb/space-registry.ts
//
// The workspace LIST, and the rule that it never comes out of a workspace.
//
// The bug this exists for, reported twice: **switching workspace showed a
// different list of workspaces.** The list was built half from
// `store.workspaces.find()` — the database THIS TAB has open — and a tab holds
// exactly one database (`tab-lock.ts`). So the list was a property of wherever the
// user happened to be standing: open `sales.edb` and everything living in the
// project index fell out of it; go back and it returned.
//
// **So the open database contributes NOTHING to the list.** Not first, not last,
// not as a fallback. That is the only arrangement in which switching cannot change
// what the list says, and it is why the earlier attempt — merge the open database
// in last — did not fix the report.
//
// The list is composed from two records instead, and both are `.edp` metadata:
// state about the SETUP, not about any one workspace.
//
//  - **the folder index** (`folder-index.ts`) — every `.edb` the connected folder
//    holds, as the last scan found it;
//  - **this module** — which workspaces each DATABASE holds, keyed by database
//    name. A tab writes its own entry while it has that database open, so every
//    other tab and every later boot can read back what a database it cannot open
//    contains. The project index (`index.edp`) is the case that needs it: it is
//    origin-private, it is not a file in the folder, and a tab that has adopted a
//    `.edb` cannot open it to ask.
//
// Both go through `deviceStore()`, so both are keys the connected folder OWNS and
// both end up in `_easydb.edp` beside the settings (`device-state.ts`). Connect
// the folder on a new machine and the workspace list is there before anything is
// scanned or opened.

import { activeWorkspaces, mergeWorkspaceList, readFolderIndex, readFolderSelection, fileActive, type ListEntry } from './folder-index.js';
import { EDB_EXTENSION } from './file-handle.js';
import { edbBridge } from './active-bridge.js';
import { deviceStore } from '../user-settings.js';
import { SPACE_REGISTRY_KEY } from './device-keys.js';
import { INDEX_DB_NAME } from './session.js';

/** A workspace as the list needs it: what routes, and what to call it. */
export interface RegisteredWorkspace {
  id: string;
  title?: string | undefined;
}

/** Database name → the workspaces it holds. */
export type SpaceRegistry = Record<string, RegisteredWorkspace[]>;

/**
 * The list changed, as an event.
 *
 * The device layer is not subscribable and the selector is already mounted when a
 * workspace is created, renamed or deleted. It listens for this the same way it
 * listens for a folder scan.
 */
export const INDEX_SPACES_CHANGED_EVENT = 'easydb:index-workspaces-changed';

function isEdb(dbName: string): boolean {
  return dbName.toLowerCase().endsWith(EDB_EXTENSION);
}

/** What each database held the last time a tab had it open. */
export function readSpaceRegistry(): SpaceRegistry {
  try {
    const raw = deviceStore()?.getItem(SPACE_REGISTRY_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    // A shape check, not a schema — this is a cache, and a value written by
    // another version is better ignored than crashed on.
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: SpaceRegistry = {};
    for (const [db, list] of Object.entries(parsed as Record<string, unknown>)) {
      if (!Array.isArray(list)) continue;
      out[db] = list.filter((w): w is RegisteredWorkspace => typeof (w as RegisteredWorkspace)?.id === 'string').map((w) => ({ id: w.id, ...(typeof w.title === 'string' ? { title: w.title } : {}) }));
    }
    return out;
  } catch {
    return {}; // private mode, or a value from another version
  }
}

function sameRegistry(a: SpaceRegistry, b: SpaceRegistry): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Write the registry. Does nothing when it has not changed.
 *
 * The no-op matters: this runs on every boot and on every write to `workspaces`,
 * and a needless save would push a file write into the folder on each keystroke of
 * a title edit.
 */
export function writeSpaceRegistry(next: SpaceRegistry): void {
  if (sameRegistry(readSpaceRegistry(), next)) return;
  try {
    deviceStore()?.setItem(SPACE_REGISTRY_KEY, JSON.stringify(next));
  } catch {
    return; // private mode, or out of room — the list is just not merged
  }
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(INDEX_SPACES_CHANGED_EVENT));
}

/**
 * Drop entries for `.edb` files the folder no longer has.
 *
 * Only ever against a scan that actually listed the folder's files: an index from
 * before `files` existed, or none at all, proves nothing about what is missing,
 * and guessing there would take a real workspace off the list.
 *
 * `index.edp` and a file kept outside the folder are never pruned — the folder has
 * nothing to say about either.
 */
function prune(reg: SpaceRegistry): SpaceRegistry {
  const files = readFolderIndex()?.files;
  if (!files) return reg;
  const have = new Set(files.map((f) => f.toLowerCase()));
  const out: SpaceRegistry = {};
  for (const [db, list] of Object.entries(reg)) {
    if (isEdb(db) && !have.has(db.toLowerCase())) continue;
    out[db] = list;
  }
  return out;
}

/**
 * Record what the database this tab has open holds.
 *
 * This is the ONLY way the open database reaches the list, and it reaches it as
 * metadata rather than as a list source — written once, read back by every tab
 * including the ones that cannot open it. That is the difference that makes the
 * list stable: what a database holds is recorded against THAT database, so
 * switching to another one adds an entry and takes none away.
 *
 * Electron on the project index is the one case skipped. There is no `index.edp`
 * inside the desktop — the store is a path the main process owns, and with no
 * folder connected `activeEdbName()` answers `index.edp` for want of a browser
 * session marker. Recording there would remember one `.db`'s workspaces as the
 * index's and then offer them as file-less rows, whose only route out is a reload
 * the desktop does not act on. No bridge means Electron, the same test
 * `space-adopt.ts` makes. A desktop tab on a real `.edb` is recorded normally,
 * because those rows carry a file and go through the backend.
 */
export function recordOpenWorkspaces(dbName: string, workspaces: readonly RegisteredWorkspace[]): void {
  if (dbName === INDEX_DB_NAME && !edbBridge()) return;
  const reg = prune(readSpaceRegistry());
  reg[dbName] = workspaces.map((w) => ({ id: w.id, ...(w.title === undefined ? {} : { title: w.title }) }));
  writeSpaceRegistry(reg);
}

/**
 * The registry as list entries: every workspace, carrying the file that holds it.
 *
 * A `.edb` key becomes the entry's `file`, which is what makes picking it a SWITCH
 * — it is opened by adopting that file. A key that is not a `.edb` is the project
 * index, so the entry carries no file and `?space=` routes it.
 */
function registryEntries(activeFile: string): ListEntry[] {
  const selection = readFolderSelection();
  const out: ListEntry[] = [];
  // Files before the project index, so that a workspace recorded in BOTH is listed
  // with the file that holds it. One workspace is in both for a while by design:
  // the first Save copies it out of the index into a `.edb` and adopts that file
  // without a reload, and the index's own copy is not deleted. Left in
  // `Object.entries` order the index's entry could win, and the list would say a
  // workspace that has just been written to disk is "stored in this browser".
  const byFileFirst = Object.entries(prune(readSpaceRegistry())).sort(([a], [b]) => Number(isEdb(b)) - Number(isEdb(a)));
  for (const [db, list] of byFileFirst) {
    // A file this device has switched off is not on the list, wherever the entry
    // came from — the same rule `activeWorkspaces` applies to the folder scan.
    if (isEdb(db) && !fileActive(db, selection, activeFile)) continue;
    for (const w of list) out.push({ id: w.id, ...(w.title === undefined ? {} : { title: w.title }), ...(isEdb(db) ? { file: db } : {}) });
  }
  return out;
}

/**
 * The whole workspace list. Takes no store, by design.
 *
 * `activeFile` is the database this tab has open, and the ONLY thing read off it
 * is the file-selection rule — it never decides what is on the list. Two tabs on
 * two different workspaces of one folder get the same answer from this, which is
 * the invariant the report was about.
 */
export function workspaceList(activeFile: string): ListEntry[] {
  // `activeWorkspaces` is normally a no-op — a scan already skips the files this
  // device has switched off. It matters for an index written BEFORE one was
  // switched off: without it the list would keep offering that workspace until the
  // next scan, and picking it would adopt the very file the user said to leave alone.
  const indexed = activeWorkspaces(readFolderIndex()?.workspaces ?? [], readFolderSelection(), activeFile);
  return mergeWorkspaceList(indexed, registryEntries(activeFile));
}
