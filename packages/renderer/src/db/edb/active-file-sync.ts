// packages/renderer/src/db/edb/active-file-sync.ts
//
// What a Sync should DO about the file this tab has open.
//
// Split from `folder-sync.ts` because it is the one rule in that file a test can
// check on its own: everything around it needs a folder handle, a worker and the
// OPFS pool, none of which exist in a Vitest run.
//
// The rule the user asked for: a Sync never loads a file silently, and never
// leaves one silently. Every outcome is either a question or something the report
// can say out loud.

import type { FileVerdict } from './file-stamp.js';

/** What to do about this tab's own file, once the verdict is in. */
export type ActiveFileSync =
  /** Nothing to load and nothing at risk. The report says which. */
  | 'nothing'
  /** The file moved on and nothing here is unsaved. Confirm, then load. */
  | 'ask-load'
  /** Both moved. Load or overwrite — either way something goes. */
  | 'ask-conflict'
  /** The file is there and nothing says how the two stand. Only the user knows. */
  | 'ask-unknown';

/**
 * The decision, from the verdict and whether the file is in the folder at all.
 *
 * `fileIsThere` is separate from the verdict because a missing file and a file we
 * have never read both answer `unknown`, and they need opposite treatment: there
 * is nothing to ask about a file that is not there.
 *
 * `file-newer` ASKS rather than loading straight away. Loading it destroys
 * nothing — that is what `file-newer` means — but it does replace what is on
 * screen with what another machine saved, and a user who did not expect that has
 * no way back. One click is the price of never being surprised.
 */
export function decideActiveFileSync(verdict: FileVerdict, fileIsThere: boolean): ActiveFileSync {
  if (!fileIsThere) return 'nothing';
  switch (verdict) {
    case 'file-newer':
      return 'ask-load';
    case 'conflict':
      return 'ask-conflict';
    case 'unknown':
      return 'ask-unknown';
    // `same` — the file is as we left it. `ahead` — we hold changes and the file
    // has not moved, so a Save is what that wants, not a Sync.
    default:
      return 'nothing';
  }
}

/**
 * What the sync did about this tab's own file, for the report.
 *
 * The toast used to say only how many workspaces the folder holds, which is the
 * same sentence whether the sync read the file or decided it could not. That is
 * what "Sync did nothing" looked like.
 */
export type ActiveFileOutcome =
  /** This tab is on the browser's own database. There is no file to sync. */
  | 'no-file'
  /** Its file is not in this folder. */
  | 'missing'
  /** The file is as we left it. */
  | 'in-step'
  /** We hold changes the file does not, and the file has not moved. */
  | 'ours-ahead'
  /** The file was re-read. The tab is reloading onto it. */
  | 'loaded'
  /** The user was asked and kept this copy. */
  | 'kept'
  /** The user was asked and wrote this copy over the file. */
  | 'overwritten';

/**
 * The clause the sync toast adds about this tab's own file.
 *
 * Empty for the two states where the file plays no part — a tab on the browser's
 * own database, and a file that is not in this folder — because naming those in
 * every toast would be noise about a thing the user did not ask about.
 */
export function describeActiveOutcome(outcome: ActiveFileOutcome, file: string): string {
  switch (outcome) {
    case 'in-step':
      return ` ${file} is up to date.`;
    case 'ours-ahead':
      return ` ${file} has unsaved changes here.`;
    case 'loaded':
      return ` Loading ${file}.`;
    case 'kept':
      return ` Kept this copy of ${file}.`;
    case 'overwritten':
      return ` Wrote this copy over ${file}.`;
    default:
      return '';
  }
}
