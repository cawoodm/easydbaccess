// packages/renderer/src/db/edb/copy-choice.ts
//
// The question asked at the moment a workspace is OPENED, when this browser and
// the folder each hold a copy of it and nothing can say which one the user means.
//
// Everything else in this layer asks about a file the tab has already adopted: a
// Save that finds the file moved, the Compare command, a folder Sync. Choosing
// the workspace in the first place — boot, or the workspace selector — asked
// nothing at all, and `decideSpace` quietly kept whichever copy the browser
// happened to hold. Where that copy was the empty database a boot makes when the
// pool is asked for a name it does not have, the workspace opened with no tables
// and the user's data sat untouched in a file nobody read.
//
// This module only ASKS. `space-adopt.ts` acts on the answer, `copy-facts.ts`
// renders the two sides, and the table-by-table settlement is `merge-file.ts` —
// which needs a live store and therefore cannot run until one of these copies has
// been adopted. That is why "Compare them…" is an answer here rather than a
// dialog: it picks the side that destroys nothing and opens the comparison on the
// other side of the reload.

import type { Dialogs } from '@easydb/shared';
import { compareCopies, sizeChangeNote, type CopyFacts } from './copy-facts.js';
import type { FileVerdict } from './file-stamp.js';
import { overwriteLosesData } from './folder-index.js';

/** The dialog's own heading. Named for what the user asked for, not for the mechanism. */
const TITLE = 'Open workspace';

/** The file wins: its copy is imported over the one this browser holds. */
export const OPEN_FILE_COPY = 'Open the copy in the file';
/** The browser wins: the file is left exactly as it is. */
export const KEEP_BROWSER_COPY = 'Keep the copy in this browser';
/** Open the browser's copy, then settle the two table by table. */
export const COMPARE_COPIES = 'Compare them…';

/** What the user asked for, once the button label is read back. */
export type CopyChoice = 'file' | 'browser' | 'compare' | 'none';

/**
 * Read the answer off the button that was pressed.
 *
 * `none` covers a dismissed dialog, and every caller treats it as "switch to
 * nothing" — the only answer that is safe to infer from silence.
 */
export function copyChoiceOf(chosen: string | null): CopyChoice {
  if (chosen === OPEN_FILE_COPY) return 'file';
  if (chosen === KEEP_BROWSER_COPY) return 'browser';
  if (chosen === COMPARE_COPIES) return 'compare';
  return 'none';
}

/**
 * Why this is being asked, in the user's terms rather than the stamp's.
 *
 * Three verdicts reach here and they are three different situations. Saying which
 * is what makes the three buttons answerable: "the other machine saved something"
 * and "this browser has never read that file" call for different answers, and a
 * single generic sentence made both look like a fault.
 *
 * Pure, so the wording is testable without a dialog.
 */
export function whyAsking(verdict: FileVerdict, file: string): string {
  switch (verdict) {
    case 'file-newer':
      return `${file} has been written since this browser last read it, so the copy on disk is the newer of the two.`;
    case 'conflict':
      return `${file} has been written since this browser last read it, and this browser holds changes of its own.`;
    default:
      // `unknown`. The common one, and the one that used to be silent: a stamp
      // only exists on the origin that imported or wrote the file, so this is
      // every new origin, browser profile and machine.
      return `Both this browser and ${file} hold this workspace, and there is no record of when the two last agreed — so easyDBAccess cannot tell which is newer.`;
  }
}

/** The two copies of one workspace, as much as each side could be counted. */
export interface CopySides {
  /** What this browser's own database holds. */
  here: CopyFacts;
  /** What the file holds, plus its size and date. */
  there: CopyFacts;
}

export interface CopyQuestion extends CopySides {
  file: string;
  verdict: FileVerdict;
  /** The file's size when this browser last agreed with it, where that is known. */
  knownSize?: number | undefined;
}

/**
 * Ask which copy to open, and make sure the answer is not a mistake.
 *
 * Three answers, each naming the copy that SURVIVES rather than the mechanism.
 * Dismissing changes nothing at all, which is why there is no Cancel among them:
 * `dialogs.choice` carries its own dismiss.
 *
 * The data-loss guard runs after the choice, not instead of it. The choice is
 * about which copy is current and the counts beside each side answer that; this
 * is the one case where the answer is almost certainly a slip — keeping an empty
 * copy over one holding tables — and that is what this whole change exists to
 * stop happening silently.
 */
export async function askWhichCopy(dialogs: Dialogs, q: CopyQuestion): Promise<CopyChoice> {
  const sides = compareCopies([
    { label: 'In this browser', facts: q.here },
    { label: q.file, facts: q.there },
  ]);
  const chosen = await dialogs.choice(`${whyAsking(q.verdict, q.file)}${sides}${sizeChangeNote(q.knownSize, q.there.size)}`, [OPEN_FILE_COPY, KEEP_BROWSER_COPY, COMPARE_COPIES], TITLE);
  const answer = copyChoiceOf(chosen);

  // Comparing loses nothing by construction — it opens one copy and then settles
  // the two — so only the two outright answers are worth a second question.
  if (answer === 'file' && !(await confirmDataLoss(dialogs, q.file, q.there, q.here, 'the copy in this browser', TITLE))) return 'none';
  if (answer === 'browser' && !(await confirmDataLoss(dialogs, q.file, q.here, q.there, `the copy in ${q.file}`, TITLE))) return 'none';
  return answer;
}

/**
 * Ask again when an answer would replace work with nothing.
 *
 * On top of a choice, not instead of it: the choice is about which copy is
 * current, and the user answers it from the counts beside each side. This is the
 * one case where the answer is almost certainly a mistake — keeping an empty copy
 * over one holding tables — and it is worth the second question, which the first
 * one's buttons cannot carry.
 *
 * `overwriteLosesData` is false whenever a count could not be taken, so a side
 * nobody could count asks nothing extra: an absent count is not a count of none.
 *
 * `title` is the dialog's own heading, because the same guard now sits behind
 * three different questions — a folder sync, a Save over an existing file, and
 * the choice above. A second dialog headed with the wrong one reads as a stray
 * prompt.
 *
 * It lives here rather than in `folder-sync.ts`, where it began, because
 * `folder-sync.ts` imports `space-adopt.ts` and `space-adopt.ts` now needs this.
 */
export function confirmDataLoss(dialogs: Dialogs, name: string, keep: CopyFacts, lose: CopyFacts, losing: string, title = 'Sync workspace folder'): Promise<boolean> | boolean {
  if (!overwriteLosesData(keep, lose)) return true;
  const held = [lose.tables ? `${lose.tables} table${lose.tables === 1 ? '' : 's'}` : '', lose.views ? `${lose.views} view${lose.views === 1 ? '' : 's'}` : ''].filter(Boolean).join(' and ');
  return dialogs.confirm(`The copy you are keeping of "${name}" is empty, and ${losing} holds ${held}. Go ahead and lose it?`, title);
}
