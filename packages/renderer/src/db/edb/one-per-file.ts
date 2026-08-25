// packages/renderer/src/db/edb/one-per-file.ts
//
// One workspace per `.edb`. The rule, and what a Save has to do to keep it.
//
// A `.edb` is a whole SQLite database and the store scopes its rows by a
// `workspaceId` column, so nothing about the FORMAT stops a file holding several
// workspaces. Everything else about the file layer assumes it does not: Save names
// the file after the workspace (`spaceFileName`), Open reads the workspace back out
// of the name (`workspaceIdFromFileName`), the folder index maps one to the other,
// and `?space=` switches workspace by adopting that workspace's file.
//
// Save broke the rule by writing `bridge.export()` — the whole DATABASE, not the
// workspace. And the tab's database routinely holds several: `local.edb` holds
// every workspace this browser has (see `session.ts`), New workspace → Simple
// inserts into whichever database is open, and a dropped `.edb` copies its
// workspace in. So the first Save of `alpha` wrote `alpha.edb` holding `alpha`,
// `beta` and everything else, and a folder scan then truthfully reported two
// workspaces living in one file.
//
// Two consequences beyond the confusing list: a sync asked which copy of the
// PASSENGER was real, because it existed in two files; and a `.edb` handed to
// somebody carried workspaces its name denies.
//
// So a Save now does two things instead of one:
//
// 1. Writes the ACTIVE workspace, alone, into its own file.
// 2. Makes sure every other workspace in the same database has a file of its own.
//
// Step 2 is not tidiness, it is what stops step 1 losing data. Before this, a
// passenger's only copy on disk was the one inside the active workspace's file;
// once that file holds the active workspace alone, a passenger with no file of its
// own would exist nowhere but this browser — and `reloadActiveFromFile` (a sync
// finding the file newer) replaces the database with the file's contents, which
// would then take it away.
//
// Pure, so the rule is tested rather than inferred from the save path.

import { spaceFileName } from './space-resolve.js';

/**
 * Can this database be written to a file as-is?
 *
 * True only when it holds exactly the one workspace, in which case the database
 * and the file are the same thing and `export()` is the whole job — the fast path,
 * and the one every already-correct workspace file takes. Anything else has to be
 * filtered down to one workspace first, which costs a copy.
 *
 * Zero is not "as-is": a database with no workspace record at all is not a file
 * this app can name, and the caller has nothing to filter to either. It returns
 * true because there is nothing to strip, and the save path has already resolved
 * an active workspace by the time it asks.
 */
export function writableWholesale(workspaceIds: readonly string[]): boolean {
  return workspaceIds.length <= 1;
}

/**
 * The workspaces that would be left with no file of their own.
 *
 * Everything in this database except the active one — whose file the Save is
 * writing — that the folder does not already hold a file for. Comparison is on the
 * FILE NAME rather than the id, because the folder is a list of names and
 * `spaceFileName` is the one rule that maps between them.
 *
 * Names are compared case-insensitively. Two ids that differ only in case are two
 * workspaces to this app and one file to Windows, so treating `Sales.edb` as
 * different from `sales.edb` would have Save write the second over the first.
 */
export function withoutTheirOwnFile(workspaceIds: readonly string[], activeId: string, filesInFolder: readonly string[]): string[] {
  const have = new Set(filesInFolder.map((f) => f.toLowerCase()));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of workspaceIds) {
    if (id === activeId || seen.has(id)) continue;
    seen.add(id);
    if (!have.has(spaceFileName(id).toLowerCase())) out.push(id);
  }
  return out;
}

/**
 * What to say about the files a Save wrote besides the one it was asked to.
 *
 * Named rather than counted while there are few of them: the first Save out of
 * browser storage can produce several files the user never asked for by name, and
 * "3 other workspaces were given files" leaves them looking for which. Past four
 * the list is longer than the sentence is useful.
 */
export function alsoWroteNote(files: readonly string[]): string {
  if (files.length === 0) return '';
  if (files.length > 4) return ` ${files.length} other workspaces were given files of their own.`;
  const list = files.length === 1 ? files[0]! : `${files.slice(0, -1).join(', ')} and ${files[files.length - 1]!}`;
  return ` ${list} ${files.length === 1 ? 'was' : 'were'} given a file too, so no workspace shares one.`;
}
