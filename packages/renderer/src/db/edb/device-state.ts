// packages/renderer/src/db/edb/device-state.ts
//
// The settings that are NOT about one workspace, kept in the folder instead of
// in this browser.
//
// The problem: everything device-local lives in `localStorage`, which is per
// ORIGIN. Open the same workspace folder in another browser, on another machine,
// or in a private window, and every preference, token and machine URL is gone —
// even though the data itself came across in the `.edb` files. Moving the folder
// to a new disk had the same effect, because nothing in the folder said what the
// setup was.
//
// So the folder carries it: `_easydb.edp`, beside the workspace files. The one
// thing that stays in the browser is WHERE the folder is, which is the one thing
// that cannot live inside it.
//
// **`.edp`, not `.edb`, and that is the whole reason the extension exists.**
// `session.ts` states the rule: `.edb` holds exactly one workspace, `.edp` holds
// something that is not one workspace. This file holds NO workspace, so every
// place that enumerates the folder for workspaces — `listWorkspaceFiles`, the
// folder sync, the Local Data dialog, drag-and-drop, the workspace selector —
// skips it without being told to. Naming it `_easydb.edb` would have meant an
// exclusion rule in each of them, and one missed spot offers the user their own
// settings file as a workspace to open.
//
// What it does NOT hold: anything per TAB (which database this tab adopted, the
// pool lock), because two tabs on one folder have to disagree about those.

import type { DataStore, Setting } from '@easydb/shared';
import { createIpcDataStore } from '../data-store-bridge.js';
import { fileInFolder, readBytes } from './file-handle.js';
import { writeUserBytes } from './guarded-write.js';
import { createEdbBridge } from './worker-bridge.js';
import { emitAllSettingsChanged } from '../settings-events.js';
import { installDeviceStore, SECRETS_KEY, USER_SETTINGS_KEY, type StorageLike } from '../user-settings.js';
import { FOLDER_INDEX_KEY, SPACE_REGISTRY_KEY } from './device-keys.js';

/** The device-state file, in the connected folder. */
export const DEVICE_FILE = '_easydb.edp';

/**
 * The workspace id the settings rows are filed under.
 *
 * `settings` is keyed `<workspaceId>::<name>`, so writing into it needs A
 * workspace id — but this database holds no workspace, and must not, or it
 * would show up in the selector. A reserved id keeps the existing collection
 * and its store untouched: no new collection, no schema change, nothing in
 * `edb-store.ts` to teach.
 */
export const DEVICE_SPACE = '_device';

/**
 * The `localStorage` keys the folder owns.
 *
 * Deliberately a LIST and not "everything under `/easydbaccess/`": a key is
 * folder-owned only if losing it is something the user would call "my setup is
 * gone". A cache (`table/row-count-cache.ts`) or a per-tab marker
 * (`session.ts`) is neither, and carrying those across devices would make two
 * machines fight over state that is correctly different on each.
 *
 * `SECRETS_KEY` is in here by an explicit decision, not by default. It holds API
 * tokens, and a folder may be synced through Dropbox or handed to someone else —
 * so this trades that risk for the goal of a folder that works on a new machine
 * with nothing typed in. The alternative was re-authenticating every connector
 * per device.
 *
 * `FOLDER_INDEX_KEY` and `SPACE_REGISTRY_KEY` are the WORKSPACE LIST, and they are
 * here because the list must not live inside a workspace. It used to be read half
 * out of `store.workspaces.find()` — the database this tab has open — and a tab
 * holds one database, so the list changed every time the user switched. Both keys
 * are the same kind of thing the two above are: state about the setup rather than
 * about any one workspace, and the place for that is the folder.
 *
 * `FOLDER_SELECTION_KEY` is deliberately NOT here. It says which files THIS machine
 * wants to look at, and carried into the folder it would hide someone else's
 * workspaces on their own computer.
 */
export const FOLDER_OWNED_KEYS: readonly string[] = [USER_SETTINGS_KEY, SECRETS_KEY, FOLDER_INDEX_KEY, SPACE_REGISTRY_KEY];

/**
 * Keys this browser may put into a folder only if the folder has no device
 * state of its own yet.
 *
 * Seeding is what stops the first connect from resetting an existing setup, and
 * for preferences it is harmless. Tokens are not: a folder that ALREADY holds a
 * device file is one somebody else set up — a share, a hand-over, a synced
 * drive — and quietly copying this machine's credentials into it is a decision
 * the user never made. Their own folder has no file on the first connect, so
 * they lose nothing.
 *
 * The workspace list is here for a plainer reason: it describes the folder it came
 * out of. Seeding one folder's list into another would offer workspaces that
 * folder does not hold. Nothing is lost by not seeding — the next scan writes the
 * real answer, and a scan runs on every connect.
 */
export const SEED_ONLY_INTO_NEW: readonly string[] = [SECRETS_KEY, FOLDER_INDEX_KEY, SPACE_REGISTRY_KEY];

/** What the folder said, for the keys it owns. Empty until a folder is read. */
let mirror = new Map<string, string>();
/** Set once a folder has been read, so a write knows it has somewhere to go. */
let connected: FileSystemDirectoryHandle | null = null;
let pending: ReturnType<typeof setTimeout> | null = null;

/**
 * Where a failed write is said out loud. Installed by `plugins/edb-file.ts`,
 * which is the layer that has a toast; this one has no `HostApi` and must not
 * grow one to report on itself.
 */
let report: ((message: string) => void) | null = null;

/** Tell the user when the folder stops taking writes. */
export function onDeviceStateError(fn: ((message: string) => void) | null): void {
  report = fn;
}

function localStore(): StorageLike | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null; // private mode / disabled
  }
}

/**
 * The storage `user-settings.ts` reads and writes through once a folder is
 * connected.
 *
 * Both layers are always written. `localStorage` keeps working on its own — with
 * no folder, before one is connected, and for the keys the folder does not own —
 * so nothing has to branch on whether a folder exists. The FOLDER is what a
 * fresh browser reads; the local copy is what makes the app work before it gets
 * there.
 */
export function deviceStorage(): StorageLike {
  // The mirror is what the FOLDER holds, so it may only exist while one is
  // connected. Populating it with no folder made this shim a second cache in
  // front of `localStorage` that nothing could clear: `89-new-plugins`
  // ("a mention survives the device layer being wiped") wipes the key and
  // expects the app to have forgotten, and the mirror kept answering.
  const owned = (key: string): boolean => connected !== null && FOLDER_OWNED_KEYS.includes(key);
  return {
    getItem(key: string): string | null {
      if (owned(key) && mirror.has(key)) return mirror.get(key) ?? null;
      return localStore()?.getItem(key) ?? null;
    },
    setItem(key: string, value: string): void {
      localStore()?.setItem(key, value);
      if (!owned(key)) return;
      mirror.set(key, value);
      scheduleSave();
    },
    removeItem(key: string): void {
      localStore()?.removeItem(key);
      if (!owned(key)) return;
      mirror.delete(key);
      scheduleSave();
    },
  };
}

/**
 * Coalesce writes.
 *
 * The Settings dialog writes a key per keystroke in some fields, and each write
 * would otherwise open a worker, build a database and write a file. The delay is
 * short enough that closing the tab straight after a change is not a realistic
 * way to lose one, and `flushDeviceState` makes that explicit where it matters.
 */
function scheduleSave(): void {
  if (!connected) return;
  installFlushOnLeave();
  if (pending) clearTimeout(pending);
  pending = setTimeout(() => {
    pending = null;
    // A save that cannot reach the folder — a lapsed grant, a removed drive —
    // must not surface as an unhandled rejection. The local layer still holds
    // every value, so nothing the user typed is lost on THIS device; what is
    // lost is the whole point of the feature, so it is said out loud.
    void saveDeviceState().catch((err: unknown) => report?.(err instanceof Error ? err.message : String(err)));
  }, 400);
}

/** Set once: the page is going away, so a coalesced write goes now. */
let flushInstalled = false;

/**
 * Best effort against the coalescing window.
 *
 * Change a setting and close the tab inside 400 ms and the folder never hears
 * about it — `localStorage` did, so it only shows up as a stale value on the
 * NEXT device, which is the hardest kind of loss to explain. `pagehide` is the
 * one event that fires for a close, a reload and a back-navigation alike; the
 * write may not finish, but starting it is strictly better than a timer that
 * has already been thrown away.
 */
function installFlushOnLeave(): void {
  if (flushInstalled || typeof window === 'undefined') return;
  flushInstalled = true;
  window.addEventListener('pagehide', () => {
    if (pending) void flushDeviceState().catch(() => {});
  });
}

/** Write now rather than in a moment. */
export async function flushDeviceState(): Promise<void> {
  if (pending) {
    clearTimeout(pending);
    pending = null;
  }
  await saveDeviceState();
}

/**
 * Read the device state out of a folder's `_easydb.edp`.
 *
 * `found` is not `values` being empty: a folder somebody else set up may hold a
 * file with nothing in it yet, and that is still their folder. It is what
 * {@link SEED_ONLY_INTO_NEW} turns on.
 */
export async function readDeviceFile(dir: FileSystemDirectoryHandle): Promise<{ found: boolean; values: Record<string, string> }> {
  const handle = await fileInFolder(dir, DEVICE_FILE, false);
  if (!handle) return { found: false, values: {} };
  const bridge = createEdbBridge();
  try {
    const bytes = await readBytes(handle);
    if (!bytes || bytes.length === 0) return { found: false, values: {} };
    // Throwaway, which is the default: `pooled` would ask for the `opfs-sahpool`
    // VFS the LIVE worker already holds — exclusive origin-wide — and the session
    // the user is looking at would start failing over a database nobody keeps.
    await bridge.open(bytes, DEVICE_FILE);
    const store: DataStore = createIpcDataStore(bridge, () => DEVICE_SPACE);
    const values: Record<string, string> = {};
    for (const row of await store.settings.find()) {
      if (typeof row.value === 'string') values[row.name] = row.value;
    }
    return { found: true, values };
  } catch {
    // An unreadable device-state file is not worth failing a connect over: the
    // local layer still answers every read, and the next save rewrites it. It
    // counts as FOUND — something is there, it just cannot be read, and that is
    // not a folder to seed credentials into.
    return { found: true, values: {} };
  } finally {
    bridge.terminate();
  }
}

/**
 * What adopting a folder does to both layers, as a decision with no I/O in it.
 *
 * Two directions at once, and each has a reason:
 *
 *  - **The folder wins** where both sides hold a key. That is the whole feature:
 *    the folder is what a second machine reads, so it has to beat whatever that
 *    machine happened to have already.
 *  - **The browser SEEDS** a key the folder does not hold yet. Without this, the
 *    first connect after this ships would answer "the folder has no settings"
 *    and reset the user to defaults — losing a setup they never chose to move.
 *
 * `toLocal` is what the browser should end up holding, so the app still works on
 * the folder's answers after a reload that happens before the folder is
 * reconnected.
 */
export function mergeDeviceState(
  fromFile: Readonly<Record<string, string>>,
  fromLocal: Readonly<Record<string, string | null>>,
  keys: readonly string[] = FOLDER_OWNED_KEYS,
  opts: { neverSeed?: readonly string[] } = {},
): { mirror: Record<string, string>; toLocal: Record<string, string>; seeded: boolean } {
  const out: Record<string, string> = { ...fromFile };
  const toLocal: Record<string, string> = {};
  const neverSeed = opts.neverSeed ?? [];
  let seeded = false;
  for (const key of keys) {
    const theirs = fromFile[key];
    if (theirs != null) {
      toLocal[key] = theirs;
      continue;
    }
    if (neverSeed.includes(key)) continue;
    const mine = fromLocal[key];
    if (mine == null) continue;
    out[key] = mine;
    seeded = true;
  }
  return { mirror: out, toLocal, seeded };
}

/**
 * Adopt a folder: take what it holds, and give it what it is missing.
 */
export async function connectDeviceState(dir: FileSystemDirectoryHandle): Promise<void> {
  // A coalesced write belongs to the folder it was made in. Switching folders
  // with one in flight would fire the timer mid-read and write THIS folder's
  // mirror into the NEXT folder's file, over whatever it held.
  if (pending) await flushDeviceState().catch(() => {});
  connected = dir;
  const local = localStore();
  const fromLocal: Record<string, string | null> = {};
  for (const key of FOLDER_OWNED_KEYS) fromLocal[key] = local?.getItem(key) ?? null;
  const file = await readDeviceFile(dir);
  const merged = mergeDeviceState(file.values, fromLocal, FOLDER_OWNED_KEYS, file.found ? { neverSeed: SEED_ONLY_INTO_NEW } : {});
  mirror = new Map(Object.entries(merged.mirror));
  for (const [key, value] of Object.entries(merged.toLocal)) local?.setItem(key, value);
  // Scheduled, not awaited. Connecting a folder is nearly always the first half
  // of something else — a Save with nowhere to go, an Open — and making that
  // wait on a second worker spinning up to write a settings file puts the user's
  // own file behind ours. The coalescing timer already owns this write.
  if (merged.seeded) scheduleSave();
}

/**
 * Connect a folder and tell the app its settings just moved.
 *
 * Every path that adopts a folder goes through here, not through
 * {@link connectDeviceState}, and there are five of them: the folder command,
 * both "there is nowhere to save this" answers, the reconnect prompt, and boot.
 * The ones that reach it through `workspaceFolder()` matter most — that is the
 * flow a browser without a persisted grant takes on EVERY visit, so a device
 * state adopted only on the explicit command would never reach those users.
 *
 * Re-adopting the folder already connected is a no-op, so calling this on a
 * path that may or may not be a change costs nothing.
 *
 * The event matters because a resolved setting is module state, set once
 * (`util/link-settings.ts`, `util/filter-settings.ts` — every reader of those is
 * a sync function called mid-paint). Adopting a folder's settings without
 * saying so leaves the app running on the values it booted with until a reload.
 */
export async function adoptDeviceFolder(dir: FileSystemDirectoryHandle): Promise<void> {
  try {
    if (connected && (await sameFolder(connected, dir))) return;
    await connectDeviceState(dir);
    emitAllSettingsChanged();
  } catch {
    // A folder whose device file cannot be read is still a usable folder: the
    // local layer answers every read, and the next write rebuilds the file.
  }
}

async function sameFolder(a: FileSystemDirectoryHandle, b: FileSystemDirectoryHandle): Promise<boolean> {
  if (a === b) return true;
  try {
    return await a.isSameEntry(b);
  } catch {
    return false;
  }
}

/** Forget the folder. The local layer keeps answering. */
export function disconnectDeviceState(): void {
  connected = null;
  mirror = new Map();
  if (pending) {
    clearTimeout(pending);
    pending = null;
  }
}

/**
 * For tests, which must not leak a folder or a mirror into the next one.
 *
 * Takes the shim back out of `user-settings.ts` too: that slot is module state
 * of its own, so clearing only the folder leaves every later test reading
 * through a layer it never installed.
 */
export function resetDeviceState(): void {
  disconnectDeviceState();
  installDeviceStore(null);
}

async function saveDeviceState(): Promise<void> {
  const dir = connected;
  if (!dir) return;
  const handle = await fileInFolder(dir, DEVICE_FILE, true);
  if (!handle) return;
  const bridge = createEdbBridge();
  let bytes: Uint8Array;
  try {
    // A fresh database every time: this file is small, holds no history, and
    // rebuilding it is cheaper than reading, diffing and patching one. Throwaway
    // is what makes that true — a `pooled` worker would restore the last mirror
    // instead of starting empty, and then keep writing `_easydb.edp` into the
    // OPFS the live worker is using.
    await bridge.open(null, DEVICE_FILE);
    const store: DataStore = createIpcDataStore(bridge, () => DEVICE_SPACE);
    for (const [name, value] of mirror) {
      await store.settings.upsert({ name, value } as Setting);
    }
    bytes = await bridge.export();
  } finally {
    bridge.terminate();
  }
  // Through the same door as every other write to a file the user owns. The
  // empty-write guard cannot fire here — it compares WORKSPACES, and this file
  // holds none on either side — but routing around the door is how the fifth
  // writer gets forgotten. See `guarded-write.ts`.
  await writeUserBytes(handle, bytes, { file: DEVICE_FILE, reason: 'Device settings' });
}
