/**
 * Comparing two copies of one workspace, table by table and row by row.
 *
 * The `.edb` layer could only ever answer "which whole FILE is newer", so the
 * only two answers it could offer were "take mine" and "take theirs" — and one
 * of those always threw away work somebody did. This module is the finer
 * question: WHICH tables differ, and inside one of those, WHICH rows.
 *
 * ## Timestamps are all there is
 *
 * There is no change log and there are no tombstones. A copy of a workspace
 * knows what it holds and when each part was last written, and nothing about
 * what it used to hold. Two consequences run through everything below:
 *
 * - **A missing row is not a deleted row.** A row here and not there was either
 *   added here or deleted there, and the two are indistinguishable. So `newest`
 *   never deletes: it settles the rows BOTH sides have, and keeps the rest. The
 *   only thing that deletes is the user explicitly saying "make this side match
 *   the other one".
 * - **The comparison is by timestamp, not by value.** Two rows with the same
 *   stamp are treated as the same row, and rows are not read to check. A file
 *   edited by a machine with a wrong clock compares wrong, which is a real
 *   limitation and not one worth a content hash of every row to fix.
 *
 * Pure: no I/O, no store, no DOM. Both callers — the browser's live database
 * and a `.edb`'s bytes in a scratch worker — hand it the same two shapes.
 */

/** Which copy. `here` is the open database, `disk` is the copy in the file. */
export type Side = 'here' | 'disk';

/**
 * What one table looks like from the outside, without reading a row of it.
 *
 * `updatedAt` is the table DOCUMENT's own stamp — its columns, filters, window.
 * `lastRowAt` is the newest row in it. They are kept apart because they answer
 * different questions: a doc that arrived later decides whose COLUMNS win, while
 * the two together decide whether the table differs at all.
 */
export interface TableStamp {
  id: string;
  name: string;
  /** The `tables` doc's own `updatedAt`. */
  updatedAt: number;
  /** How many rows the table holds. */
  rows: number;
  /** `MAX(updatedAt)` across those rows; 0 for an empty table. */
  lastRowAt: number;
}

/** One row, as thin as a comparison can be. */
export interface RowStamp {
  id: string;
  updatedAt: number;
}

/**
 * When the table was last touched AT ALL — the doc or any row in it.
 *
 * Editing a cell does not write the `tables` doc, so the doc's own stamp alone
 * would call a table with an hour of edits in it unchanged.
 */
export function tableTouchedAt(t: TableStamp): number {
  return Math.max(t.updatedAt, t.lastRowAt);
}

/** How two copies of one thing stand. */
export type DiffState =
  /** Present on both sides and indistinguishable. */
  | 'same'
  /** Only the open database has it. */
  | 'here-only'
  /** Only the file has it. */
  | 'disk-only'
  /** Both have it, and they disagree. */
  | 'differs';

/** What the user wants done about one difference. */
export type MergeChoice =
  /** This side wins: the file is brought into line with the open database. */
  | 'here'
  /** The file wins: the open database is brought into line with it. */
  | 'disk'
  /** Whichever was written last wins — and neither side loses what only it has. */
  | 'newest'
  /** Leave both copies exactly as they are. */
  | 'skip';

/** One table as the two copies have it. Either side may be absent. */
export interface TableDiff {
  /** The table's name, which is what the user recognises it by. */
  name: string;
  state: DiffState;
  here?: TableStamp | undefined;
  disk?: TableStamp | undefined;
  /** Which copy was written last, or `same` when they are level (or one-sided). */
  newer: Side | 'same';
}

/** One row as the two copies have it. */
export interface RowDiff {
  id: string;
  state: DiffState;
  hereAt?: number | undefined;
  diskAt?: number | undefined;
  newer: Side | 'same';
}

/**
 * Which of two stamps is later. Equal reads as `same`, and so does a pair where
 * one side is missing — there is nothing to compare, and calling the present one
 * "newer" would invite a caller to delete the absent one.
 */
function laterOf(here: number | undefined, disk: number | undefined): Side | 'same' {
  if (here === undefined || disk === undefined) return 'same';
  if (here > disk) return 'here';
  if (disk > here) return 'disk';
  return 'same';
}

/**
 * Pair the tables of two copies up.
 *
 * **By id first, then by name.** The id is the real identity and survives a
 * rename; the name catches the table that was deleted and re-made — the ordinary
 * refresh loop for anything backed by a URL — which comes back with a new id
 * under the old name. Matching on the id alone would call that pair two
 * unrelated tables and offer to keep both.
 *
 * Sorted by name, because the result is read as a list by a person.
 */
export function diffTables(here: readonly TableStamp[], disk: readonly TableStamp[]): TableDiff[] {
  const unmatched = new Map(disk.map((t) => [t.id, t]));
  const byName = new Map<string, TableStamp>();
  for (const t of disk) if (!byName.has(t.name)) byName.set(t.name, t);

  const out: TableDiff[] = [];
  for (const mine of here) {
    let theirs = unmatched.get(mine.id);
    if (!theirs) {
      const named = byName.get(mine.name);
      // Only if that one has not already been claimed by its own id.
      if (named && unmatched.has(named.id)) theirs = named;
    }
    if (!theirs) {
      out.push({ name: mine.name, state: 'here-only', here: mine, newer: 'same' });
      continue;
    }
    unmatched.delete(theirs.id);
    const same = tableTouchedAt(mine) === tableTouchedAt(theirs) && mine.rows === theirs.rows;
    out.push({
      name: mine.name,
      state: same ? 'same' : 'differs',
      here: mine,
      disk: theirs,
      // Level stamps with different row counts have no newer side. That is the
      // one pair `newest` cannot settle, and saying `same` is what makes it fall
      // through to keeping both rather than picking one at random.
      newer: same ? 'same' : laterOf(tableTouchedAt(mine), tableTouchedAt(theirs)),
    });
  }
  for (const theirs of unmatched.values()) {
    out.push({ name: theirs.name, state: 'disk-only', disk: theirs, newer: 'same' });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The same pairing for the rows of ONE table, by id and by id only.
 *
 * A row has no name and no natural key this layer knows about, so an id that
 * appears on one side is a row the other side does not have. That is the whole
 * reason `newest` keeps both: which of "added here" and "deleted there" it was
 * cannot be recovered from what is stored.
 */
export function diffRows(here: readonly RowStamp[], disk: readonly RowStamp[]): RowDiff[] {
  const theirs = new Map(disk.map((r) => [r.id, r.updatedAt]));
  const out: RowDiff[] = [];
  for (const mine of here) {
    const at = theirs.get(mine.id);
    if (at === undefined) {
      out.push({ id: mine.id, state: 'here-only', hereAt: mine.updatedAt, newer: 'same' });
      continue;
    }
    theirs.delete(mine.id);
    const same = at === mine.updatedAt;
    out.push({
      id: mine.id,
      state: same ? 'same' : 'differs',
      hereAt: mine.updatedAt,
      diskAt: at,
      newer: same ? 'same' : laterOf(mine.updatedAt, at),
    });
  }
  for (const [id, at] of theirs) out.push({ id, state: 'disk-only', diskAt: at, newer: 'same' });
  return out;
}

/**
 * What to do about a difference when the user has not said.
 *
 * `newest` for anything that differs at all, and nothing for what already
 * matches. See {@link winnerOf} for why that one rule is also the union: a thing
 * only one side has has no rival to lose to, so `newest` keeps it and carries it
 * across.
 */
export function defaultChoice(state: DiffState): MergeChoice {
  return state === 'same' ? 'skip' : 'newest';
}

/**
 * Which side wins one difference, or `null` for "touch neither copy".
 *
 * **`newest` never deletes.** A thing only one side has is not a thing that lost
 * — it has no rival — so the side that HAS it wins and it is carried to the
 * other. That is the whole difference between merging and overwriting, and it is
 * what makes "Take newest" safe to offer as the default: run it on two copies
 * that were both worked on and you get everything from both, with the clock
 * settling only the parts that genuinely collide.
 *
 * `null` is reached in two ways: `skip`, and a pair that differs with no newer
 * side — two copies stamped the same millisecond holding different numbers of
 * rows. There is no answer to that one, and inventing one would pick a winner at
 * random.
 *
 * An explicit `here` or `disk` is taken at its word, one-sided or not: a user
 * asking for one copy to be made to match the other is asking for exactly that,
 * deletions included.
 */
export function winnerOf(diff: { state: DiffState; newer: Side | 'same' }, choice: MergeChoice): Side | null {
  if (choice === 'skip') return null;
  if (choice === 'here' || choice === 'disk') return choice;
  if (diff.newer !== 'same') return diff.newer;
  if (diff.state === 'here-only') return 'here';
  if (diff.state === 'disk-only') return 'disk';
  return null;
}

/** How many of each kind, for a sentence about the whole comparison. */
export interface DiffCounts {
  same: number;
  differs: number;
  hereOnly: number;
  diskOnly: number;
}

export function countDiffs(diffs: readonly { state: DiffState }[]): DiffCounts {
  const counts: DiffCounts = { same: 0, differs: 0, hereOnly: 0, diskOnly: 0 };
  for (const d of diffs) {
    if (d.state === 'same') counts.same++;
    else if (d.state === 'differs') counts.differs++;
    else if (d.state === 'here-only') counts.hereOnly++;
    else counts.diskOnly++;
  }
  return counts;
}

/** True when the two copies hold the same things — nothing to settle. */
export function inStep(counts: DiffCounts): boolean {
  return counts.differs === 0 && counts.hereOnly === 0 && counts.diskOnly === 0;
}

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

/**
 * The comparison as one sentence: `2 tables differ, 1 only here, 3 only in the
 * file`.
 *
 * Says nothing about the tables that MATCH — a list of what is fine is not what
 * the reader is deciding about. Empty when there is nothing to report, so the
 * caller can tell "in step" from "three differences" without counting again.
 */
export function describeDiffs(counts: DiffCounts, noun = 'table'): string {
  const parts: string[] = [];
  if (counts.differs > 0) parts.push(`${plural(counts.differs, noun)} differ${counts.differs === 1 ? 's' : ''}`);
  if (counts.hereOnly > 0) parts.push(`${plural(counts.hereOnly, noun)} only here`);
  if (counts.diskOnly > 0) parts.push(`${plural(counts.diskOnly, noun)} only in the file`);
  return parts.join(', ');
}

/**
 * One side's plan for one table: what to bring in, and what to take out.
 *
 * Deliberately expressed as row IDS rather than rows. The rows themselves are
 * read from the winning side at the moment they are applied, so nothing here
 * holds a copy of a 600,000-row table.
 */
export interface RowPlan {
  /** Rows to copy from the file into the open database. */
  pull: string[];
  /** Rows to copy from the open database into the file. */
  push: string[];
  /** Rows to delete HERE, because the user said this table must match the file. */
  dropHere: string[];
  /** Rows to delete from the FILE, because the user said the file must match here. */
  dropDisk: string[];
}

export function emptyRowPlan(): RowPlan {
  return { pull: [], push: [], dropHere: [], dropDisk: [] };
}

export function rowPlanIsEmpty(p: RowPlan): boolean {
  return p.pull.length === 0 && p.push.length === 0 && p.dropHere.length === 0 && p.dropDisk.length === 0;
}

/**
 * Turn per-row answers into the four lists that get executed.
 *
 * A row's winner decides which way it moves, and its STATE decides whether
 * moving it means a copy or a delete: `here-only` losing to the file is a row
 * the file does not have, so bringing that side into line means deleting it.
 *
 * `choiceFor` is asked per row rather than passed as one value, because the
 * record-level dialog lets the user answer them one at a time.
 */
export function planRows(diffs: readonly RowDiff[], choiceFor: (d: RowDiff) => MergeChoice): RowPlan {
  const plan = emptyRowPlan();
  for (const d of diffs) {
    if (d.state === 'same') continue;
    const winner = winnerOf(d, choiceFor(d));
    if (winner === null) continue;
    if (winner === 'disk') {
      if (d.state === 'here-only') plan.dropHere.push(d.id);
      else plan.pull.push(d.id);
    } else {
      if (d.state === 'disk-only') plan.dropDisk.push(d.id);
      else plan.push.push(d.id);
    }
  }
  return plan;
}
