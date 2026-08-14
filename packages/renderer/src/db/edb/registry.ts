// packages/renderer/src/db/edb/registry.ts
//
// **Which store each workspace lives in.** One entry per workspace this origin
// knows about: a file name for a workspace kept in a `.edb`, and null for one
// kept in IndexedDB.
//
// This replaces a single `easydb:edb:active` key that named the one file "this
// tab" had open. That key was wrong about its own scope: `localStorage` is per
// ORIGIN, exactly like IndexedDB, so one file name governed every tab and every
// workspace at once. Opening a `.edb` therefore hid every IndexedDB workspace
// from the selector — they were still there, but nothing in the app named them —
// and a second tab on another workspace was switched over behind its back.
//
// Both stores are per origin, so the choice between them has to be recorded at
// the granularity the user works at, which is the WORKSPACE. Then the selector
// can list everything, two tabs can hold two workspaces in two different stores,
// and boot binds the store the resolved workspace asks for.
//
// Why LOCAL workspaces are in here too, when the Dexie store could list them
// itself: a load backed by a `.edb` never opens Dexie, so from inside a file
// there is no other way to name them. The alternative — opening IndexedDB just
// to read its workspace list — would create the very database the file mode
// exists to avoid, and `indexedDB.databases()` (needed to check first) does not
// exist in Firefox.
//
// The registry is a device-local INDEX, not the data. A `.edb` carries its own
// workspace record and Dexie carries its own, so nothing here is authoritative:
// losing it costs the list, not the data. `app-context.ts` records the workspace
// it resolved on every boot, so an entry that goes missing comes back the next
// time that workspace is opened.

/** Every workspace this origin knows about, by workspace id. */
const KEY = 'easydb:edb:workspaces';

/**
 * The key the single-file version wrote. Read once, never written: a user who
 * had a file open when this landed would otherwise boot into IndexedDB and see
 * the workspace they were working in disappear — the very fault this fixes.
 */
const LEGACY_KEY = 'easydb:edb:active';

export interface KnownWorkspace {
  /** The workspace id — the slug the URL's `?space=` resolves to. */
  id: string;
  /** Shown in the selector, which must name a workspace it cannot open yet. */
  name: string;
  /** The `.edb` it lives in, or null for IndexedDB. */
  file: string | null;
}

type Stored = Record<string, { name: string; file?: string }>;

function read(): Stored {
  try {
    const raw = globalThis.localStorage?.getItem(KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    const out: Stored = {};
    for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value !== 'object' || value === null) continue;
      const { name, file } = value as { name?: unknown; file?: unknown };
      // A `file` that is not a non-empty string means IndexedDB, not a broken
      // entry: that is what a local workspace stores. `file` is what a worker is
      // asked to open, so anything else must not reach it.
      out[id] = typeof file === 'string' && file !== '' ? { name: typeof name === 'string' && name !== '' ? name : id, file } : { name: typeof name === 'string' && name !== '' ? name : id };
    }
    return out;
  } catch {
    return {}; // private mode, disabled storage, or corrupt JSON
  }
}

function write(map: Stored): void {
  try {
    if (Object.keys(map).length === 0) globalThis.localStorage?.removeItem(KEY);
    else globalThis.localStorage?.setItem(KEY, JSON.stringify(map));
  } catch {
    /* best-effort: without it the workspace still opens, it just is not remembered */
  }
}

/** Every workspace this origin knows about, in either store. */
export function knownWorkspaces(): KnownWorkspace[] {
  return Object.entries(read()).map(([id, { name, file }]) => ({ id, name, file: file ?? null }));
}

/** The file `workspaceId` lives in, or null when it lives in IndexedDB. */
export function fileOf(workspaceId: string): string | null {
  return read()[workspaceId]?.file ?? null;
}

/**
 * Record where a workspace lives. Also used to MOVE one — into a file when it is
 * converted, to another file after Save As.
 */
export function rememberWorkspace(entry: KnownWorkspace): void {
  const map = read();
  map[entry.id] = entry.file === null ? { name: entry.name } : { name: entry.name, file: entry.file };
  write(map);
}

/** Forget one workspace. Any file it named is not touched. */
export function forgetWorkspace(workspaceId: string): void {
  const map = read();
  if (!(workspaceId in map)) return;
  delete map[workspaceId];
  write(map);
}

/**
 * Bring the roster into line with the store this load actually opened.
 *
 * Recording only the ONE workspace a load resolved is not enough, and the gap
 * shows: a user with five workspaces in IndexedDB has five stores' worth of data
 * and an almost empty roster, so a load backed by a `.edb` lists only the ones
 * that happen to have been opened since. The two lists then disagree, which is
 * the fault this whole registry exists to remove.
 *
 * So every boot declares what its own store holds. `inStore` is the full workspace
 * list of the active store and `file` is where that store's data lives — null for
 * IndexedDB. After visiting each store once the roster is the union of both, and
 * it stays that way.
 *
 * Two rules keep this from doing damage:
 *
 * 1. **An existing entry is never overwritten.** Converting a workspace to a file
 *    LEAVES the IndexedDB copy in place (the copy is additive by design), so that
 *    workspace is in both stores. A Dexie boot listing it must not relabel it as
 *    local and strand the file it really opens from.
 * 2. **Only the active store's own entries are pruned.** A workspace this store
 *    holds no record of, and that this store is supposed to hold, has been deleted
 *    — dropping it stops the selector offering a workspace whose data is gone,
 *    which boot would answer by creating an empty one. Entries belonging to other
 *    files are left alone, because this load cannot see inside them.
 */
export function reconcileRoster(inStore: ReadonlyArray<{ id: string; name: string }>, file: string | null): void {
  const map = read();
  const here = new Set(inStore.map((w) => w.id));
  let changed = false;

  for (const w of inStore) {
    if (w.id in map) continue;
    map[w.id] = file === null ? { name: w.name } : { name: w.name, file };
    changed = true;
  }

  for (const [id, entry] of Object.entries(map)) {
    const sameStore = (entry.file ?? null) === file;
    if (!sameStore || here.has(id)) continue;
    delete map[id];
    changed = true;
  }

  if (changed) write(map);
}

/**
 * Adopt the pre-registry `easydb:edb:active` marker, once.
 *
 * Called only when the resolved workspace has no file of its own. The marker
 * named a file but no workspace, so the workspace being opened right now is the
 * only candidate — which is exactly the one the old code would have shown.
 * Returns the file it adopted, or null when there was no marker.
 */
export function adoptLegacyMarker(workspaceId: string, name: string): string | null {
  let file: string | null;
  try {
    file = globalThis.localStorage?.getItem(LEGACY_KEY) ?? null;
    if (file) globalThis.localStorage?.removeItem(LEGACY_KEY);
  } catch {
    return null;
  }
  if (!file) return null;
  rememberWorkspace({ id: workspaceId, name, file });
  return file;
}
