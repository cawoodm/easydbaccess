// packages/renderer/src/db/edb/file-identity.ts
//
// Does the workspace inside a `.edb` match the name on the file?
//
// `one-per-file.ts` states the rule from the WRITING side: a `.edb` holds one
// workspace, and Save names the file after it. This module is the reading side —
// what to do about a file in the folder that breaks the rule.
//
// The case from the field: the folder holds `a.edb` and `b.edb`, and both hold the
// workspace `a`. Nothing rejects that, and the app has no way to act on it:
//
//   * The selector lists `a` twice, and the file name beside each is the only
//     difference. Both entries mean the same thing to the app.
//   * Picking either one goes through `?space=a`, and that resolves the file from
//     the id (`spaceFileName`), so it always opens `a.edb`. The `b.edb` entry is a
//     button that does something else than it says.
//   * A clash with the copy in this browser is matched on the workspace NAME, so
//     one local `a` clashes with both files and asks the same question twice.
//   * Save writes `a.edb`, so the copy in `b.edb` is never written again and comes
//     back at every sync as a workspace that will not go away.
//
// There is no repair the app can pick on its own. Either file may hold the work the
// user wants, and the id inside the file is what every table, view and setting in
// it is keyed by. So this module only says WHICH files are wrong and what could be
// done about them, and the user answers.
//
// Pure: the rule is a comparison between two strings the scan already has.

import type { FolderWorkspace } from './folder-index.js';
import { spaceFileName, workspaceIdFromFileName } from './space-resolve.js';

/** What can be done about one file. */
export type IdentityFix =
  /** The workspace inside is the one the file name says. Nothing to do. */
  | 'matches'
  /**
   * The file name says one workspace and the file holds another.
   *
   * Fixable: rename the workspace inside the file to the id the name claims. The
   * file keeps its data and the pair agree afterwards.
   */
  | 'rename'
  /**
   * Two file names claim the same id, so no rename can tell them apart.
   *
   * `My Data.edb` and `my-data.edb` both slugify to `my-data`
   * (`workspaceIdFromFileName`), so renaming either one to the id its own name
   * claims lands on the id the other one already has. Only the user can say which
   * file is the real `my-data`, by renaming a file on disk.
   */
  | 'ambiguous';

/** One file in the folder, and how its name stands against what is inside it. */
export interface FileIdentity {
  file: string;
  /** The id the workspace inside the file carries. */
  id: string;
  /** That workspace's technical name, for the question to quote. */
  name: string;
  /** The id the file NAME claims. `b.edb` claims `b`. */
  claimed: string;
  fix: IdentityFix;
  /** For `ambiguous`: the other files whose names claim the same id. */
  rivals: string[];
  /** When the file was last written, so a question about it can say. */
  mtime?: number | undefined;
  /** Its size, for the same reason. */
  size?: number | undefined;
}

/** Case-insensitive, like every other file-name comparison in this layer. */
function sameFile(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/**
 * One entry per file, saying whether its name and its contents agree.
 *
 * **A file holding several workspaces is left out entirely.** That is a different
 * broken shape — a file written before v0.0.427, when Save wrote the whole database
 * into one file — and it has an owner already (`one-per-file.ts`). Renaming one of
 * several passengers would not make the file right, and picking which passenger the
 * name is about is a guess. Such a file keeps working as it does today.
 */
export function fileIdentities(found: readonly FolderWorkspace[]): FileIdentity[] {
  const perFile = new Map<string, FolderWorkspace[]>();
  for (const w of found) {
    const key = w.file.toLowerCase();
    const list = perFile.get(key);
    if (list) list.push(w);
    else perFile.set(key, [w]);
  }

  const alone = [...perFile.values()].filter((list) => list.length === 1).map((list) => list[0]!);

  // Which files claim each id. A group of more than one is the ambiguous case, and
  // it is decided here rather than per file because no file can see its rivals.
  const claimants = new Map<string, string[]>();
  for (const w of alone) {
    const claimed = workspaceIdFromFileName(w.file);
    const list = claimants.get(claimed);
    if (list) list.push(w.file);
    else claimants.set(claimed, [w.file]);
  }

  return alone.map((w) => {
    const claimed = workspaceIdFromFileName(w.file);
    const group = claimants.get(claimed) ?? [w.file];
    const rivals = group.filter((f) => !sameFile(f, w.file));
    // With rivals, the file this app would itself have written for that id wins:
    // `spaceFileName` is the one name Save produces, so `my-data.edb` is the real
    // `my-data` and `My Data.edb` is a copy somebody renamed. Where no file carries
    // the canonical name, none of them can be preferred.
    const ambiguous = rivals.length > 0 && !sameFile(w.file, spaceFileName(claimed));
    const fix: IdentityFix = ambiguous ? 'ambiguous' : w.id === claimed ? 'matches' : 'rename';
    return {
      file: w.file,
      id: w.id,
      name: w.name,
      claimed,
      fix,
      rivals,
      ...(w.mtime === undefined ? {} : { mtime: w.mtime }),
      ...(w.size === undefined ? {} : { size: w.size }),
    };
  });
}

/** Only the files that need an answer, in the order the scan found them. */
export function misfiledFiles(found: readonly FolderWorkspace[]): FileIdentity[] {
  return fileIdentities(found).filter((i) => i.fix !== 'matches');
}

/**
 * The scan result with those files taken out.
 *
 * What "do not open it" comes to. The index is what the selector lists and what
 * the clash prompts read, so a file dropped here is a file the app does not act on
 * — it is not deleted, moved or written, and the next sync finds it again and asks
 * again. The file on disk is still wrong, and only the user can settle that.
 */
export function withoutFiles(found: readonly FolderWorkspace[], files: readonly string[]): FolderWorkspace[] {
  const out = new Set(files.map((f) => f.toLowerCase()));
  return found.filter((w) => !out.has(w.file.toLowerCase()));
}

/**
 * The scan result as it looks once the workspace in `file` has been renamed to `to`.
 *
 * Applied rather than re-scanned: a scan reads every file in the folder whole, and
 * the one thing that changed is a string this side just wrote.
 */
export function afterRename(found: readonly FolderWorkspace[], file: string, to: string): FolderWorkspace[] {
  return found.map((w) => (sameFile(w.file, file) ? { ...w, id: to, name: to } : w));
}
