// packages/renderer/src/db/edb/merge-file.ts
//
// The question a tab asks when its file has moved on: not "which copy do you
// want to keep" but "what do you want done about each part that differs".
//
// Two places reach this — a Save that finds the file has been written since, and
// a Sync of the connected folder — and they used to ask the same two-button
// question in two different wordings. Both now offer the same four answers, and
// both go through this one module, because everything below "which button" is
// identical: read the file, compare, act, write, say what happened.
//
// Nothing here decides anything about the DATA. `replicate.ts` owns the rules,
// `replicate-run.ts` carries them out, and this is the part that knows about a
// file handle, a permission, a dialog and a toast.

import type { DataStore, DiffCounts, Dialogs } from '@easydb/shared';
import { countDiffs, defaultChoice, describeDiffs } from '@easydb/shared';
import { openMergeDialog } from '../../dialogs/merge-dialog.js';
import { clearAppProgress, setAppProgress } from '../../chrome/app-progress-signal.js';
import { factsOfHandle, recordDivergence } from './file-stamp.js';
import { COMPARE, NEWEST, PULL, PUSH, answerOf, type FileAnswer } from './merge-answers.js';
import { nothingToSettle, openComparison, type MergeOutcome, type MergePlan } from './replicate-run.js';
import { writeBytes } from './file-handle.js';
import type { EdbBridge } from './worker-bridge.js';

export interface MergeContext {
  handle: FileSystemFileHandle;
  /** The file's name, as every message about it says. */
  file: string;
  /** The workspace as the OPEN database knows it. */
  workspaceId: string;
  store: DataStore;
  bridge: EdbBridge;
  dialogs: Dialogs;
}

export interface MergeResult {
  /** False when the user backed out, or there was nothing to do. */
  merged: boolean;
  outcome?: MergeOutcome | undefined;
  /** True when the file's bytes were rewritten. */
  wroteFile: boolean;
}

/**
 * Compare this workspace with the copy in `handle` and settle the differences.
 *
 * `mode` picks how much the user is asked. `newest` settles everything by the
 * clock without a dialog; `compare` opens the table list and lets them answer
 * per table — and, from there, per record.
 *
 * Returns `merged: false` when there was nothing to settle or the user
 * cancelled, and in that case NOTHING has been written on either side.
 */
export async function mergeWithFile(ctx: MergeContext, mode: 'newest' | 'compare'): Promise<MergeResult> {
  const bytes = await readFileBytes(ctx.handle);
  if (!bytes) {
    await ctx.dialogs.alert(`${ctx.file} could not be read, so there is nothing to compare with.`, 'Compare');
    return { merged: false, wroteFile: false };
  }

  setAppProgress({ label: `Comparing with ${ctx.file}`, detail: 'Reading the file' });
  let comparison;
  try {
    comparison = await openComparison(ctx.store, ctx.bridge, bytes, ctx.workspaceId);
  } catch (err) {
    clearAppProgress();
    await ctx.dialogs.alert(`${ctx.file} could not be compared: ${err instanceof Error ? err.message : String(err)}`, 'Compare');
    return { merged: false, wroteFile: false };
  }

  try {
    clearAppProgress();
    const counts = countDiffs(comparison.tables);
    const templateCounts = countDiffs(comparison.views.templates);
    const instanceCounts = countDiffs(comparison.views.instances);
    // Views are diffed too, and ALL of tables/templates/instances have to be
    // in step for there to be nothing to do. Checking `counts` alone was the
    // bug this closes: a chart added on one side with every table untouched
    // compared as "nothing to do" and the chart never crossed — the reported
    // bug, one layer down, because tables were never the only thing a merge
    // could carry.
    if (nothingToSettle(counts, templateCounts, instanceCounts)) {
      // The whole point of comparing: a file whose timestamp moved may hold
      // exactly what we hold. Saying so is a better answer than a dialog with
      // nothing in it.
      ctx.dialogs.toast(`Every table matches the copy in ${ctx.file}.`, { kind: 'info', title: 'Compare' });
      return { merged: false, wroteFile: false };
    }

    const plan = mode === 'newest' ? allNewest(comparison.tables) : await openMergeDialog(comparison, ctx.file);
    if (!plan) return { merged: false, wroteFile: false };

    setAppProgress({ label: `Merging with ${ctx.file}`, detail: describeMergeScope(counts, templateCounts, instanceCounts) });
    const { outcome, bytes: merged } = await comparison.apply(plan, (detail) => setAppProgress({ label: `Merging with ${ctx.file}`, detail }));

    let wroteFile = false;
    if (merged) {
      await writeBytes(ctx.handle, merged);
      wroteFile = true;
    }
    await restamp(ctx.file, ctx.handle);
    ctx.dialogs.toast(describeOutcome(outcome, ctx.file), { kind: 'success', title: 'Compare' });
    return { merged: true, outcome, wroteFile };
  } finally {
    clearAppProgress();
    comparison.close();
  }
}

/** Every difference settled by the clock, and nothing one-sided lost. */
function allNewest(tables: readonly { name: string; state: Parameters<typeof defaultChoice>[0] }[]): MergePlan {
  return { tables: new Map(tables.map((d) => [d.name, defaultChoice(d.state)])), rows: new Map() };
}

/**
 * The progress line's detail: tables, and — only when there is one — a view
 * clause too. Without this a merge that touches only views showed a blank
 * detail while it worked, which reads as hung rather than as doing something.
 *
 * Templates and instances are summed into one "view" count here: the gate
 * that decides whether there is anything to do needs them apart (an instance
 * with no template makes no sense, but the reverse is ordinary), but one
 * progress clause naming both collections separately would read as more detail
 * than the sentence needs.
 */
function describeMergeScope(tableCounts: DiffCounts, templateCounts: DiffCounts, instanceCounts: DiffCounts): string {
  const viewCounts: DiffCounts = {
    same: templateCounts.same + instanceCounts.same,
    differs: templateCounts.differs + instanceCounts.differs,
    hereOnly: templateCounts.hereOnly + instanceCounts.hereOnly,
    diskOnly: templateCounts.diskOnly + instanceCounts.diskOnly,
  };
  return [describeDiffs(tableCounts), describeDiffs(viewCounts, 'view')].filter((s) => s !== '').join('; ');
}

async function readFileBytes(handle: FileSystemFileHandle): Promise<Uint8Array | null> {
  try {
    return new Uint8Array(await (await handle.getFile()).arrayBuffer());
  } catch {
    return null;
  }
}

/**
 * What this browser knows about the file, after a merge.
 *
 * Always `recordDivergence`, never `recordAgreement` — even when the merge wrote
 * the file. A merge settles tables, rows, view templates and view instances, but
 * NOT `settings` — `Setting` carries no `updatedAt`, so there is no clock to
 * settle it by, and it is left as each side had it. That means the file is still
 * not a full copy of this database, and claiming otherwise would let the next
 * Save write over it without asking. Marked as ours-ahead instead, which is what
 * it is: the file's current facts are recorded (so the pair stays comparable and
 * the next outside write is seen), and the ordinary Save that follows brings the
 * file the rest of the way.
 */
async function restamp(file: string, handle: FileSystemFileHandle): Promise<void> {
  const facts = await factsOfHandle(handle);
  if (facts) recordDivergence(file, facts);
}

/** One sentence about what a merge did. Names tables, because counts do not. */
export function describeOutcome(o: MergeOutcome, file: string): string {
  const parts: string[] = [];
  if (o.pulled.length > 0) parts.push(`took ${o.pulled.join(', ')} from ${file}`);
  if (o.pushed.length > 0) parts.push(`wrote ${o.pushed.join(', ')} out to it`);
  if (o.viewsIn > 0 || o.viewsOut > 0) parts.push(`settled ${o.viewsIn + o.viewsOut} view${o.viewsIn + o.viewsOut === 1 ? '' : 's'}`);
  if (parts.length === 0) return `Nothing changed on either side.`;
  const rows = [o.rowsIn > 0 ? `${o.rowsIn.toLocaleString()} in` : '', o.rowsOut > 0 ? `${o.rowsOut.toLocaleString()} out` : ''].filter(Boolean).join(', ');
  return `Merged: ${parts.join('; ')}${rows ? ` (${rows} rows)` : ''}.`;
}

/**
 * The question itself, with what differs written into it.
 *
 * The summary is the reason the four answers are answerable at all: "2 tables
 * differ, 1 only here" tells the user whether this is a clash worth reading or
 * one machine that is simply behind.
 */
export async function askAboutFile(ctx: MergeContext, lead: string, sides: string): Promise<FileAnswer> {
  const chosen = await ctx.dialogs.choice(`${lead}${sides}`, [NEWEST, COMPARE, PUSH, PULL], 'Compare');
  return answerOf(chosen);
}
