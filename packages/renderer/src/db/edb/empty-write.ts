// packages/renderer/src/db/edb/empty-write.ts
//
// The last line of defence before a write replaces a file's work with nothing.
//
// Every other guard in this app asks its question about a workspace: the folder
// sync compares the two copies of one workspace (`overwriteLosesData`), Save
// compares this browser's copy against the file's (`sidesAgainstFile`). Each is
// worth having, and neither covers the case reported here — a write that goes
// through the normal path, with nothing objecting, and lands an EMPTY database on
// top of a full one. If any bookkeeping upstream is wrong, those guards are wrong
// with it, because they read the same bookkeeping.
//
// So this one reads neither the store nor a stamp. It compares the BYTES about to
// be written against the BYTES on disk, both measured the same way, and it is the
// last thing that happens before the handle is opened for writing. A guard that
// shares no state with what it is guarding cannot be fooled by the same bug.
//
// Pure. `guarded-write.ts` does the reading and asks the question.

/** What a database's bytes hold, summed over every workspace inside them. */
export interface Holding {
  workspaces: number;
  tables: number;
  views: number;
}

export const NOTHING: Holding = { workspaces: 0, tables: 0, views: 0 };

/** Sum a peeked file into one holding. */
export function holdingOf(peeked: readonly { tables: number; views: number }[]): Holding {
  return {
    workspaces: peeked.length,
    tables: peeked.reduce((n, w) => n + w.tables, 0),
    views: peeked.reduce((n, w) => n + w.views, 0),
  };
}

/**
 * Does this hold anything the user made?
 *
 * Tables and view instances only — `isEmptyWorkspace`'s rule. A workspace one
 * second old already carries seeded view templates and settings rows, so counting
 * those would make every database look used and this would never be true.
 *
 * The workspace COUNT is deliberately not part of it: a file holding three
 * workspaces and no tables holds nothing, which is exactly the shape the reported
 * data loss had.
 */
export function holdsNothing(h: Holding): boolean {
  return h.tables === 0 && h.views === 0;
}

/**
 * Would this write destroy work and put nothing in its place?
 *
 * Deliberately only the TOTAL wipe, not any shrink. Deleting a table is ordinary
 * work, and a red two-step alarm on every such save would be ignored within a
 * day — which would cost more than it saves. The one case with no innocent
 * reading is "the file holds tables, the bytes hold none".
 */
export function wouldWipe(onDisk: Holding, writing: Holding): boolean {
  return !holdsNothing(onDisk) && holdsNothing(writing);
}

function plural(n: number, noun: string): string {
  return `${n.toLocaleString()} ${noun}${n === 1 ? '' : 's'}`;
}

/** `3 tables and 2 views`, or `3 tables` when there are no views. */
export function describeHolding(h: Holding): string {
  const parts = [plural(h.tables, 'table')];
  if (h.views > 0) parts.push(plural(h.views, 'view'));
  return parts.join(' and ');
}

/**
 * The first question. States what is in the file, what is about to replace it,
 * and that this is not a normal save.
 *
 * Says the FILE NAME, because the answer depends on which file it is: a user with
 * a folder of workspaces has no other way to tell which one is about to go.
 */
export function firstWarning(file: string, onDisk: Holding, writing: Holding): string {
  return [
    `“${file}” holds ${describeHolding(onDisk)}.`,
    `The workspace open here holds nothing — ${describeHolding(writing)}.`,
    '',
    'Saving now REPLACES the file with an empty workspace. Everything in it is lost, and there is no undo.',
    '',
    'This is almost never what you want. If the tables are missing from the screen but present in the file, the file is the good copy — cancel, and open it instead.',
  ].join('\n');
}

/** The second question, deliberately worded as the consequence, not the action. */
export function secondWarning(file: string, onDisk: Holding): string {
  return [`Last chance. This deletes ${describeHolding(onDisk)} from “${file}”.`, '', 'Nothing else will ask.'].join('\n');
}

/** What the toast says after the user stops a write. */
export function refusedNote(file: string): string {
  return `Nothing was written. “${file}” is untouched.`;
}
