// packages/renderer/src/db/edb/replicate-run.ts
//
// Running a comparison between the open database and the copy inside a `.edb`,
// and carrying out what the user decides about it.
//
// The rules live in `@easydb/shared`'s `replicate.ts` and are pure. This is the
// part that has to touch two databases at once, and everything awkward about it
// comes from that:
//
//   * The file's copy is opened in a THROWAWAY worker, the same way a folder
//     scan peeks at one and the same way "save this workspace as its own file"
//     already builds a filtered copy. The pool is exclusive origin-wide, so a
//     second worker never gets it and the scratch database is in memory — which
//     is what makes it safe to open somebody's file without importing it.
//   * That scratch is dressed as a plain `DataStore`, so the merge is written
//     against the same interface as everything else in the app rather than
//     against SQL. Both sides are just stores; nothing below here knows which
//     one is the file.
//   * The two directions touch DISJOINT tables and rows — a difference has one
//     winner — so the order the two sides are written in cannot matter, and
//     neither pass has to work from a snapshot of the other.
//
// The file is not written here. This produces the merged BYTES and hands them
// back; writing them (and the permission, the stamp, the toast) stays with the
// caller that owns the file handle.

import type { DataStore, MergeChoice, RowDiff, RowStamp, Table, TableDiff, TableStamp } from '@easydb/shared';
import { diffRows, diffTables, planRows, winnerOf } from '@easydb/shared';
import { createEdbBridge, type EdbBridge } from './worker-bridge.js';
import { createIpcDataStore } from '../data-store-bridge.js';

/** The scratch database's name. One per origin, reused, never opened by a boot. */
const MERGE_SCRATCH = '__edb-merge-scratch.edb';

/**
 * Rows written per batch when a table is copied across.
 *
 * The same size `convert.ts` uses, for the same reason: one statement batch,
 * small enough that a big table reports progress rather than appearing hung.
 */
const ROW_CHUNK = 1000;

/**
 * The answers for one table's rows.
 *
 * A `fallback` as well as the per-row answers, because the record list is
 * CAPPED: a table with four thousand differing rows is not a list anybody reads,
 * and without a fallback everything past the cap would silently go unmerged —
 * the user would accept a merge and find half of it had not happened.
 */
export interface RowAnswers {
  /** What to do about a row the user did not answer individually. */
  fallback: MergeChoice;
  byId: Map<string, MergeChoice>;
}

/** What the user decided, per table name and — where they drilled in — per row. */
export interface MergePlan {
  /** Table name → what to do about it. A name that is absent is left alone. */
  tables: Map<string, MergeChoice>;
  /**
   * Table name → the answers for its rows.
   *
   * Present only for a table the user opened the record comparison on. When a
   * table has an entry here it is settled ROW BY ROW and its `tables` answer is
   * ignored — except for the table document itself, which follows whichever side
   * wrote it last.
   */
  rows: Map<string, RowAnswers>;
}

export function emptyPlan(): MergePlan {
  return { tables: new Map(), rows: new Map() };
}

/**
 * How many differing rows the record comparison will show at once.
 *
 * A cap on the DOM, not on the merge: everything past it is still settled, by
 * the list's own "all of them" answer. Reading a row is a primary-key lookup per
 * table, so this is also what keeps opening the list from costing a scan of a
 * 600,000-row table nobody is going to read row by row.
 */
export const RECORD_LIMIT = 200;

/** One differing row, with enough of it to be recognised. */
export interface RecordView {
  diff: RowDiff;
  /** The row's first column value, or its id where there is nothing better. */
  label: string;
  /** Fields whose values disagree. Empty where only one side has the row. */
  changed: string[];
  here?: Record<string, unknown> | undefined;
  disk?: Record<string, unknown> | undefined;
}

/** The capped list, and how many there were in total. */
export interface RecordList {
  items: RecordView[];
  /** Differing rows in the table, including the ones past the cap. */
  total: number;
  /** The column the labels came from, for the list's own heading. */
  labelField?: string | undefined;
}

/** What a merge did, for the sentence the user gets afterwards. */
export interface MergeOutcome {
  /** Tables brought in or updated from the file. */
  pulled: string[];
  /** Tables written out to the file. */
  pushed: string[];
  /** Rows copied into this database. */
  rowsIn: number;
  /** Rows copied out to the file. */
  rowsOut: number;
  /** True when the file's copy changed and the bytes have to be written. */
  fileChanged: boolean;
}

function emptyOutcome(): MergeOutcome {
  return { pulled: [], pushed: [], rowsIn: 0, rowsOut: 0, fileChanged: false };
}

/**
 * A comparison in progress. Holds the scratch worker open, so it MUST be closed.
 *
 * Deliberately stateful and deliberately short-lived: the dialog above it walks
 * from tables to records and back, and re-opening the file for each step would
 * mean deserializing the whole database every time the user expands a table.
 */
export interface Comparison {
  /** The workspace being compared, as this database knows it. */
  workspaceId: string;
  /** Every table of it, paired up. Sorted by name. */
  tables: TableDiff[];
  /** The rows of one table, paired up by id. Two numbers per row, no contents. */
  rowsOf(name: string): Promise<RowDiff[]>;
  /**
   * The differing rows of one table with enough of their contents to recognise
   * them — what the record comparison shows.
   */
  recordsOf(name: string, limit?: number): Promise<RecordList>;
  /** Carry out a plan. Returns the merged file bytes when the file changed. */
  apply(plan: MergePlan, report?: (label: string) => void): Promise<{ outcome: MergeOutcome; bytes: Uint8Array | null }>;
  /** Release the scratch worker. Safe to call twice. */
  close(): void;
}

/** The stamps of one side, as a map keyed the way the appliers want them. */
interface SideTables {
  store: DataStore;
  workspaceId: string;
  stamps: TableStamp[];
}

/**
 * Open `bytes` — a `.edb`'s contents — beside the open database and pair the two
 * up.
 *
 * `workspaceId` is the OPEN database's id for the workspace. The file's own id
 * is read from the file rather than assumed to match: a workspace can be renamed
 * on one side, and reading the file under the wrong id would compare this
 * workspace against nothing and call every table "only here".
 *
 * Throws when the file holds no workspace at all — a caller that got this far
 * has already peeked at it, so that means the file changed underneath us.
 */
export async function openComparison(here: DataStore, hereBridge: EdbBridge, bytes: Uint8Array, workspaceId: string): Promise<Comparison> {
  const scratch = createEdbBridge();
  try {
    await scratch.open(bytes, MERGE_SCRATCH, { scratch: true });
    const spaces = (await createIpcDataStore(scratch, () => workspaceId).workspaces.find()) as { id: string }[];
    const diskId = spaces.find((w) => w.id === workspaceId)?.id ?? spaces[0]?.id;
    if (diskId === undefined) throw new Error('That file holds no workspace to compare with.');
    const disk: SideTables = { store: createIpcDataStore(scratch, () => diskId), workspaceId: diskId, stamps: await scratch.tableStamps(diskId) };
    const mine: SideTables = { store: here, workspaceId, stamps: await hereBridge.tableStamps(workspaceId) };
    return makeComparison(mine, disk, scratch, hereBridge);
  } catch (err) {
    scratch.terminate();
    throw err;
  }
}

function makeComparison(here: SideTables, disk: SideTables, scratch: EdbBridge, hereBridge: EdbBridge): Comparison {
  const tables = diffTables(here.stamps, disk.stamps);
  const byName = new Map(tables.map((d) => [d.name, d]));
  let open = true;

  /** Row stamps from whichever side has the table, or none where it does not. */
  const stampsOf = async (bridge: EdbBridge, id: string | undefined): Promise<RowStamp[]> => (id === undefined ? [] : bridge.rowStamps(id));

  return {
    workspaceId: here.workspaceId,
    tables,
    async rowsOf(name) {
      const diff = byName.get(name);
      if (!diff) return [];
      const [mine, theirs] = await Promise.all([stampsOf(hereBridge, diff.here?.id), stampsOf(scratch, diff.disk?.id)]);
      return diffRows(mine, theirs);
    },
    async recordsOf(name, limit = RECORD_LIMIT) {
      const diff = byName.get(name);
      if (!diff || !diff.here || !diff.disk) return { items: [], total: 0 };
      const all = (await this.rowsOf(name)).filter((d) => d.state !== 'same');
      const shown = all.slice(0, limit);
      const doc = (await here.store.tables.findOne(diff.here.id)) as Table | null;
      const labelField = doc?.labelColumn ?? doc?.columns?.[0]?.field;
      const items: RecordView[] = [];
      for (const d of shown) {
        // Only the rows on show are read, and only from the side that has them.
        // The comparison itself never reads a row — this is the one step that
        // does, which is why it is behind a cap and behind the user asking.
        const mine = d.state === 'disk-only' ? null : ((await here.store.rows(diff.here.id).findOne(d.id)) as RowDoc | null);
        const theirs = d.state === 'here-only' ? null : ((await disk.store.rows(diff.disk.id).findOne(d.id)) as RowDoc | null);
        items.push({
          diff: d,
          label: labelOf(mine?.data ?? theirs?.data, labelField, d.id),
          changed: mine && theirs ? changedFields(mine.data, theirs.data) : [],
          here: mine?.data,
          disk: theirs?.data,
        });
      }
      return { items, total: all.length, labelField };
    },
    async apply(plan, report = () => {}) {
      const outcome = await runPlan(here, disk, tables, plan, report);
      // Exporting is not free — it is the whole database's bytes — so it happens
      // only where the file's copy actually changed. A merge that only pulled
      // leaves the file exactly as it was, and rewriting it would move its
      // timestamp for nothing and make the NEXT comparison think it had moved.
      const bytes = outcome.fileChanged ? await scratch.export() : null;
      return { outcome, bytes };
    },
    close() {
      if (!open) return;
      open = false;
      scratch.terminate();
    },
  };
}

/** One row as both sides hold it. */
type RowDoc = { id: string; tableId: string; data: Record<string, unknown>; updatedAt: number };

/**
 * What to call a row in a list of them.
 *
 * The table's label column if it has one, else its first column, else the id —
 * which is a UUID and tells the reader nothing, but is better than a blank line
 * and is only reached for a table with no columns at all.
 */
function labelOf(data: Record<string, unknown> | undefined, field: string | undefined, id: string): string {
  const value = field && data ? data[field] : undefined;
  const text = value == null ? '' : String(value).trim();
  return text === '' ? id : text;
}

/**
 * Which fields two copies of one row disagree about.
 *
 * Compared as TEXT, the way the grid shows them: `3` and `"3"` are the same cell
 * to a reader, and a list of differences that includes them would send the user
 * looking for a change that is not there. Every key either side has is checked,
 * so a field added on one side counts as a difference.
 */
function changedFields(a: Record<string, unknown>, b: Record<string, unknown>): string[] {
  const seen = new Set([...Object.keys(a), ...Object.keys(b)]);
  const text = (v: unknown) => (v == null ? '' : String(v));
  return [...seen].filter((k) => text(a[k]) !== text(b[k])).sort();
}

/**
 * Every row of one table, indexed by id — read ONCE per side per table.
 *
 * The comparison itself never does this: it asks the worker for two numbers per
 * row (`rowStamps`). This is the applying side, which needs the rows themselves
 * to move them, and reading each side once is what keeps that to one pass rather
 * than one per row.
 */
async function rowsById(store: DataStore, tableId: string): Promise<Map<string, RowDoc>> {
  const rows = await store.rows(tableId).find();
  return new Map(rows.map((r) => [r.id, r as RowDoc]));
}

/**
 * Copy a whole table from one side to the other, replacing what is there.
 *
 * The TARGET's id is kept when it already has the table. Ids are how everything
 * else in the workspace points at a table — a view instance, a projection source,
 * the open window — so taking the other side's id would leave all of them
 * pointing at nothing, and the user would watch their windows empty out because
 * they accepted a newer copy of the data inside them.
 */
async function copyTable(from: DataStore, to: DataStore, fromId: string, toId: string, workspaceId: string, report: (label: string) => void): Promise<number> {
  const doc = (await from.tables.findOne(fromId)) as Table | null;
  if (!doc) return 0;
  report(`Copying ${doc.name}`);
  await to.tables.upsert({ ...doc, id: toId, workspaceId });

  // Out with the old rows first. `bulkRemove` over the ids rather than a wipe,
  // because the store has no "empty this table" and building one would be a
  // second path into the same DDL.
  const existing = (await to.rows(toId).find()).map((r) => r.id);
  if (existing.length > 0) await to.rows(toId).bulkRemove(existing);

  const rows = await from.rows(fromId).find();
  for (let i = 0; i < rows.length; i += ROW_CHUNK) {
    const chunk = rows.slice(i, i + ROW_CHUNK).map((r) => ({ ...r, tableId: toId }));
    await to.rows(toId).bulkInsert(chunk);
    report(`Copying ${doc.name} — ${Math.min(i + ROW_CHUNK, rows.length).toLocaleString()} of ${rows.length.toLocaleString()} rows`);
  }
  return rows.length;
}

/**
 * Write named rows into one side, leaving every other row of that table alone.
 *
 * One `upsert` each rather than a `bulkInsert`: the row may already be there
 * under the same id — that is what `differs` means — and a bulk insert would
 * replace it with a new physical row, which is how an edited row once jumped to
 * the bottom of the grid (see `edb-store.ts`).
 */
async function writeRows(to: DataStore, toId: string, source: ReadonlyMap<string, RowDoc>, ids: readonly string[]): Promise<number> {
  let written = 0;
  for (const id of ids) {
    const doc = source.get(id);
    if (!doc) continue;
    await to.rows(toId).upsert({ ...doc, tableId: toId });
    written++;
  }
  return written;
}

/**
 * Carry out one plan.
 *
 * Table by table, and each table settled entirely one way or the other unless
 * the user opened its records — in which case the rows are settled individually
 * and the table DOCUMENT follows whichever side wrote it last. That last rule
 * matters more than it looks: the doc is where the columns are, so ignoring it
 * would land a pulled row's new field in the JSON overflow instead of in a
 * column of its own.
 */
async function runPlan(here: SideTables, disk: SideTables, diffs: readonly TableDiff[], plan: MergePlan, report: (label: string) => void): Promise<MergeOutcome> {
  const out = emptyOutcome();

  for (const diff of diffs) {
    if (diff.state === 'same') continue;
    const rowAnswers = plan.rows.get(diff.name);

    // -- settled row by row -------------------------------------------------
    if (rowAnswers && diff.here && diff.disk) {
      const hereId = diff.here.id;
      const diskId = diff.disk.id;
      report(`Merging ${diff.name}`);

      // The document first, so a pulled row lands in the columns it belongs to
      // rather than in the JSON overflow beside them.
      if (diff.here.updatedAt !== diff.disk.updatedAt) {
        const fromHere = diff.here.updatedAt > diff.disk.updatedAt;
        const from = fromHere ? here : disk;
        const to = fromHere ? disk : here;
        const doc = (await from.store.tables.findOne(fromHere ? hereId : diskId)) as Table | null;
        if (doc) {
          await to.store.tables.upsert({ ...doc, id: fromHere ? diskId : hereId, workspaceId: to.workspaceId });
          if (fromHere) out.fileChanged = true;
        }
      }

      // Read at APPLY time, not reused from the comparison. The dialog can sit
      // open for as long as the user reads it, and the open database is live
      // underneath — an autosave, a plugin, the grid behind the dialog. A row
      // that changed while they decided keeps its current contents; one that
      // appeared has no answer, so `planRows` leaves it alone.
      const mine = await rowsById(here.store, hereId);
      const theirs = await rowsById(disk.store, diskId);
      const stamps = (m: ReadonlyMap<string, RowDoc>): RowStamp[] => [...m.values()].map((r) => ({ id: r.id, updatedAt: r.updatedAt }));
      const rowPlan = planRows(diffRows(stamps(mine), stamps(theirs)), (d) => rowAnswers.byId.get(d.id) ?? rowAnswers.fallback);

      out.rowsIn += await writeRows(here.store, hereId, theirs, rowPlan.pull);
      out.rowsOut += await writeRows(disk.store, diskId, mine, rowPlan.push);
      if (rowPlan.dropHere.length > 0) await here.store.rows(hereId).bulkRemove(rowPlan.dropHere);
      if (rowPlan.dropDisk.length > 0) await disk.store.rows(diskId).bulkRemove(rowPlan.dropDisk);

      if (rowPlan.pull.length > 0 || rowPlan.dropHere.length > 0) out.pulled.push(diff.name);
      if (rowPlan.push.length > 0 || rowPlan.dropDisk.length > 0) {
        out.pushed.push(diff.name);
        out.fileChanged = true;
      }
      continue;
    }

    // -- settled as a whole -------------------------------------------------
    const winner = winnerOf(diff, plan.tables.get(diff.name) ?? 'skip');
    if (winner === null) continue;

    if (winner === 'disk') {
      if (diff.state === 'here-only' && diff.here) {
        // The user asked this side to match the file, and the file does not have
        // it. The only answer that means anything is to remove it.
        report(`Removing ${diff.name}`);
        await here.store.tables.remove(diff.here.id);
        out.pulled.push(diff.name);
      } else if (diff.disk) {
        out.rowsIn += await copyTable(disk.store, here.store, diff.disk.id, diff.here?.id ?? diff.disk.id, here.workspaceId, report);
        out.pulled.push(diff.name);
      }
      continue;
    }

    if (diff.state === 'disk-only' && diff.disk) {
      report(`Removing ${diff.name} from the file`);
      await disk.store.tables.remove(diff.disk.id);
      out.pushed.push(diff.name);
      out.fileChanged = true;
    } else if (diff.here) {
      out.rowsOut += await copyTable(here.store, disk.store, diff.here.id, diff.disk?.id ?? diff.here.id, disk.workspaceId, report);
      out.pushed.push(diff.name);
      out.fileChanged = true;
    }
  }

  return out;
}

