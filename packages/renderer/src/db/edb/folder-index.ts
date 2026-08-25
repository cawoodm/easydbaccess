// packages/renderer/src/db/edb/folder-index.ts
//
// What the connected workspace folder holds, and how it merges with the database
// this tab has open.
//
// The problem it solves: a workspace's data lives in a file, but the workspace
// LIST is a table inside one file, and a tab can only hold one database at a time
// (the pool's files are exclusive origin-wide — see `tab-lock.ts`). So the only
// place that can say "the `sales` workspace lives in `sales.edb`" is outside every
// database.
//
// Device-local, and deliberately a CACHE rather than a record: it is rebuilt from
// the folder by `folder-sync.ts`, so a stale entry costs one failed lookup and
// heals on the next scan. Nothing here is authoritative, which is why no schema
// changed to make room for it and why a `.edb` handed to someone else carries none
// of it.

import type { WorkspaceContents } from '@easydb/shared';

/** One workspace found in one file in the folder. */
export interface FolderWorkspace {
  id: string;
  name: string;
  title?: string | undefined;
  /** The `.edb` in the connected folder that holds it. */
  file: string;
  /**
   * What the copy IN THE FILE holds, and what the file itself looks like.
   *
   * All optional: an index written by an older version has none of it, and this
   * is a cache nothing may depend on. They exist for the conflict prompts, which
   * cannot ask "which copy do you want" usefully without them — `size` and
   * `mtime` belong to the FILE, so every workspace in one file repeats them.
   */
  tables?: number | undefined;
  views?: number | undefined;
  size?: number | undefined;
  mtime?: number | undefined;
}

export interface FolderIndex {
  /** The folder's display name, for the selector and the sync report. */
  folder: string;
  /** When the scan ran, so the UI can say how old this is. */
  at: number;
  workspaces: FolderWorkspace[];
}

const KEY = 'eda:folderIndex';

export function readFolderIndex(): FolderIndex | null {
  try {
    const raw = globalThis.localStorage?.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as FolderIndex;
    // A shape check, not a schema: this is a cache, and a version of the app that
    // wrote it differently is better ignored than crashed on.
    return Array.isArray(parsed?.workspaces) ? parsed : null;
  } catch {
    return null; // private mode, or a value from another version
  }
}

export function writeFolderIndex(index: FolderIndex): void {
  try {
    globalThis.localStorage?.setItem(KEY, JSON.stringify(index));
  } catch {
    /* private mode, or out of room — the app works, the list is just not merged */
  }
}

export function clearFolderIndex(): void {
  try {
    globalThis.localStorage?.removeItem(KEY);
  } catch {
    /* nothing to clear that anything can reach */
  }
}

/** A workspace as the selector needs to show it. */
export interface ListEntry {
  id: string;
  name: string;
  /** The display title, when the workspace has one. See {@link workspaceLabel}. */
  title?: string | undefined;
  /**
   * The file holding it, when that is NOT this tab's database.
   *
   * Present is what makes an entry a SWITCH rather than a selection: picking it
   * goes through `?space=`, which adopts the file and reloads.
   */
  file?: string | undefined;
}

/**
 * What to CALL a workspace on screen.
 *
 * `title` is the display name and `name` is the technical one `?space=` routes on
 * (see `types.ts`), so everything a user reads goes through here — the selector
 * showed `name` and went on showing it after a title edit, which reads as the edit
 * not having taken. A blank title is no title, matching the header.
 */
export function workspaceLabel(w: { name: string; title?: string | undefined }): string {
  return w.title?.trim() || w.name;
}

const byLabel = (a: ListEntry, b: ListEntry) => workspaceLabel(a).localeCompare(workspaceLabel(b));

/**
 * Only the entries from OTHER files. Deduplicated on (id, file), because two
 * scans of the same folder must not double the list.
 */
function elsewhere(indexed: FolderWorkspace[], activeFile: string): FolderWorkspace[] {
  const seen = new Set<string>();
  const out: FolderWorkspace[] = [];
  for (const w of indexed) {
    if (w.file === activeFile) continue; // already in the open database
    const key = `${w.id}\u0000${w.file}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(w);
  }
  return out.sort(byLabel);
}

/**
 * What the workspace selector should list.
 *
 * The open database's workspaces come first and unqualified, then everything the
 * folder holds elsewhere, each labelled with its file.
 *
 * A name in BOTH appears twice, on purpose. `Cancel` at the conflict prompt means
 * "leave both", so both have to stay reachable — and the file qualifier is what
 * tells them apart, since the name cannot.
 */
export function mergeWorkspaceList(open: readonly { id: string; name: string; title?: string | undefined }[], indexed: readonly FolderWorkspace[], activeFile: string): ListEntry[] {
  // `title` is omitted rather than set to undefined when there is none:
  // `exactOptionalPropertyTypes` is on, and an absent key is what the callers
  // compare against.
  const entry = <T extends { id: string; name: string; title?: string | undefined }>(w: T): ListEntry => ({ id: w.id, name: w.name, ...(w.title === undefined ? {} : { title: w.title }) });
  const mine = [...open].map(entry).sort(byLabel);
  return [...mine, ...elsewhere([...indexed], activeFile).map((w) => ({ ...entry(w), file: w.file }))];
}

/**
 * One workspace that exists on both sides, and the two ids it goes by.
 *
 * The ids are kept apart because they need not agree. Matching is on the NAME —
 * the technical field the user manages — and two workspaces can carry one name
 * under different ids: `freeWorkspaceId` mints `sales-2` when `sales` is taken,
 * and a rename moves the name without moving the id. Whoever acts on a clash
 * needs both: the local id says what to write, the file's id says what to
 * replace inside that file.
 */
export interface FolderClash {
  /** The copy in the folder, as the scan found it. */
  file: FolderWorkspace;
  /** The id of the workspace HERE that carries the same name. */
  localId: string;
}

/** The name two copies are matched by. Case-insensitive, like the file names. */
function nameKey(name: string): string {
  return name.trim().toLowerCase();
}

/**
 * The workspaces a scan found in the folder that the open database ALSO has.
 *
 * This is what gets a prompt, one per workspace: two copies of one workspace
 * exist and only the user knows which is the real one.
 *
 * Matched on `name`, not on `id`. The id is a slug of the name, so the two agreed
 * for as long as nothing renamed anything — and then quietly stopped: a renamed
 * workspace kept an id spelling a name it no longer has, and its copy in the
 * folder was treated as a different workspace and listed twice. The name is the
 * field the user manages, so it is the one they mean by "the same workspace".
 *
 * The first local workspace of a name wins where several share one. That is a
 * state the app does not make, and picking one beats asking about each pairing.
 */
export function folderConflicts(open: readonly { id: string; name: string }[], indexed: readonly FolderWorkspace[], activeFile: string): FolderClash[] {
  const here = new Map<string, string>();
  for (const w of open) if (!here.has(nameKey(w.name))) here.set(nameKey(w.name), w.id);
  const out: FolderClash[] = [];
  for (const w of elsewhere([...indexed], activeFile)) {
    const localId = here.get(nameKey(w.name));
    if (localId) out.push({ file: w, localId });
  }
  return out;
}

/**
 * Would keeping `keep` and dropping `replace` throw away the only copy of some
 * work?
 *
 * True only when one side holds nothing and the other holds something. A count
 * nobody could take is `undefined` and answers false — an absent count is not a
 * count of none, the same rule `copy-facts.ts` renders by. So this never invents
 * a warning out of missing information, which would train the user to click past
 * the one that matters.
 */
export function overwriteLosesData(keep: { tables?: number | undefined; views?: number | undefined }, replace: { tables?: number | undefined; views?: number | undefined }): boolean {
  const holds = (c: { tables?: number | undefined; views?: number | undefined }): boolean | undefined => {
    if (c.tables === undefined && c.views === undefined) return undefined;
    return (c.tables ?? 0) > 0 || (c.views ?? 0) > 0;
  };
  return holds(keep) === false && holds(replace) === true;
}

/**
 * Whether a workspace holds nothing the user put there.
 *
 * Tables and view instances only. A workspace created a moment ago already has
 * seeded view templates and settings rows — 4 and 8 of them on v0.0.396 — so
 * counting those would make every workspace look used and this would never be
 * true of anything.
 */
export function isEmptyWorkspace(c: WorkspaceContents): boolean {
  return c.tables === 0 && c.views === 0;
}

/**
 * Split the conflicts into the ones that answer themselves and the ones only the
 * user can answer.
 *
 * A conflict is worth a prompt when both sides hold work, which is the case the
 * prompt was written for. It is NOT the case when the local side is an empty
 * shell, and the app makes those itself: `?space=simon` creates an empty `simon`
 * whenever it cannot find that workspace at boot, and at boot it cannot look in
 * a folder nobody has connected yet (see `space-resolve.ts`). A private window
 * hits this every time — no local database, no remembered folder, so the
 * requested workspace is created, and connecting the folder a moment later then
 * asked which of the two `simon`s was real when one of them was seconds old and
 * empty.
 *
 * An empty local side has nothing to lose, so the file wins with no question —
 * the same reasoning `decideSpace` applies to `hasLocalDb`.
 */
export function partitionConflicts(clashes: readonly FolderClash[], emptyLocally: ReadonlySet<string>): { adopt: FolderClash[]; ask: FolderClash[] } {
  const adopt: FolderClash[] = [];
  const ask: FolderClash[] = [];
  for (const c of clashes) (emptyLocally.has(c.localId) ? adopt : ask).push(c);
  return { adopt, ask };
}
