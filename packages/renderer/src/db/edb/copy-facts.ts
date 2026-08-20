// packages/renderer/src/db/edb/copy-facts.ts
//
// Saying what a copy of a workspace HOLDS, for the questions that ask the user to
// pick one of two.
//
// Three prompts ask that question — a folder sync finds the same workspace here
// and in a file, this tab's own file was written by something else, a dropped
// file carries a workspace name this browser already uses — and all three used to
// ask it with nothing but a name. Two copies called `sales` are indistinguishable
// on a name, so the answer was a guess, and one of the two answers destroys work.
//
// What tells them apart is what a user would look at in a file manager: how many
// tables, how big the file is, when it was last written. None of it is a decision
// this module makes — it only puts the numbers where the question is.
//
// Pure, and deliberately so: every caller is an interactive prompt, and a message
// builder that reads nothing can be tested for what it says.

/**
 * What is known about ONE copy. Every field is optional because each caller can
 * see a different subset — a copy in this browser has no file size, and a file
 * this app has not peeked into has no table count.
 */
export interface CopyFacts {
  /** Tables in that copy of the workspace. */
  tables?: number | undefined;
  /** Open views (view instances) in that copy. */
  views?: number | undefined;
  /** Workspaces the copy holds — only for a question about a whole FILE. */
  workspaces?: number | undefined;
  /** The file's size in bytes. A copy in this browser has no file, so no size. */
  size?: number | undefined;
  /** When the file was last written, as epoch ms. */
  mtime?: number | undefined;
}

/** One noun, singular or plural. */
function plural(n: number, noun: string): string {
  return `${n.toLocaleString()} ${noun}${n === 1 ? '' : 's'}`;
}

/**
 * A size as a person reads one: "128 KB", "40.2 MB".
 *
 * Binary units, because that is what every file manager shows for a file on disk
 * and this number is read next to one.
 */
export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return plural(Math.max(0, Math.round(bytes)), 'byte');
}

/**
 * When a file was last written, on the reader's clock.
 *
 * `dateStyle`/`timeStyle` rather than a hand-built format: the order of the parts
 * and the separators belong to the reader's locale, and seconds are noise in a
 * dialog read at a glance.
 */
export function formatWhen(mtime: number, locale?: string): string {
  return new Date(mtime).toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'short' });
}

/**
 * One copy as one phrase: `3 tables, 2 views, 128 KB, saved 20 Aug 2026, 09:14`.
 *
 * Absent facts are left out rather than shown as zero or as "unknown": a count
 * this side could not take is not the same as a count of none, and a dialog that
 * says "0 tables" about a workspace full of them is worse than one that says
 * nothing.
 *
 * Empty when nothing is known, so a caller can drop the whole line.
 */
export function describeCopy(facts: CopyFacts, locale?: string): string {
  const parts: string[] = [];
  if (facts.workspaces !== undefined) parts.push(plural(facts.workspaces, 'workspace'));
  if (facts.tables !== undefined) parts.push(plural(facts.tables, 'table'));
  // Views only when there are any: an open view is a detail, and "0 views" on
  // every line is noise on the numbers that decide the answer.
  if (facts.views !== undefined && facts.views > 0) parts.push(plural(facts.views, 'view'));
  if (facts.size !== undefined) parts.push(formatBytes(facts.size));
  if (facts.mtime !== undefined) parts.push(`saved ${formatWhen(facts.mtime, locale)}`);
  return parts.join(', ');
}

/**
 * What changed about a file since we last agreed with it, when the size says so.
 *
 * Only the size: a timestamp that moved says nothing on its own — a save that
 * rewrote the same data moves it too — while "it was 96 KB and is now 128 KB"
 * tells the reader the other machine ADDED something. Blank when the sizes match
 * or either is missing, so the sentence never appears empty-handed.
 */
export function sizeChangeNote(was: number | undefined, now: number | undefined): string {
  if (was === undefined || now === undefined || was === now) return '';
  return `\n\nIt was ${formatBytes(was)} when this tab last read it.`;
}

/** One side of the comparison: what to call it, and what is known about it. */
export interface LabelledCopy {
  label: string;
  facts: CopyFacts;
}

/**
 * The two copies as a block to append to a question, one line each.
 *
 * Blank when neither side has anything to show, which is what keeps the caller's
 * message a plain sentence in a browser that told us nothing. A side with no
 * facts is dropped on its own too — a lone labelled line still helps, because the
 * other copy's numbers are the ones the reader cannot otherwise see.
 */
export function compareCopies(sides: readonly LabelledCopy[], locale?: string): string {
  const lines = sides.map((s) => ({ label: s.label, text: describeCopy(s.facts, locale) })).filter((s) => s.text !== '');
  return lines.length === 0 ? '' : `\n\n${lines.map((s) => `${s.label}: ${s.text}`).join('\n')}`;
}
