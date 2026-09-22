// packages/renderer/src/db/edb/merge-answers.ts
//
// The four answers to "this file and this copy disagree", as the buttons say
// them.
//
// Their own module because two callers need the STRINGS and only one of them can
// afford the code behind them: `folder-sync.ts` is imported by tests that run in
// Node with no DOM, and `merge-file.ts` pulls in a Lit dialog. Four constants
// cannot be duplicated safely — a button labelled one thing and compared against
// another is a branch that never runs — so they live here, where importing them
// costs nothing.

/** This copy wins: the file is brought into line with it. */
export const PUSH = 'Push — overwrite the file from here';
/** The file wins: this copy is brought into line with it. */
export const PULL = 'Pull — overwrite this copy from the file';
/** Whichever part was written last wins, and nothing one-sided is lost. */
export const NEWEST = 'Take newest';
/** Open the table-by-table comparison and decide there. */
export const COMPARE = 'Compare tables…';

/** What the user is asking for, once the button label is read back. */
export type FileAnswer = 'push' | 'pull' | 'newest' | 'compare' | 'none';

/**
 * Read the answer off the button that was pressed.
 *
 * `none` covers a dismissed dialog, which every caller treats as "touch
 * nothing" — the only answer that is safe to infer from silence.
 */
export function answerOf(chosen: string | null): FileAnswer {
  if (chosen === PUSH) return 'push';
  if (chosen === PULL) return 'pull';
  if (chosen === NEWEST) return 'newest';
  if (chosen === COMPARE) return 'compare';
  return 'none';
}
