// packages/shared/src/workspace-id.ts
//
// A workspace has exactly TWO names, and this module owns the technical one.
//
//   id    — the technical identifier. It IS the file name (`sales` ⇄ `sales.edb`),
//           it is what `?space=` routes on, and it keys every setting, view and
//           table in the workspace. Unique, and enforced as such by the store.
//   title — what the user calls it. Free text, may repeat, may be empty, and
//           nothing is ever derived from it.
//
// There used to be a third, `name`, sitting between them: minted from the same
// slug as the id, shown wherever the title was absent, and free to drift from
// both. It is what made `powerplants.edb` show two rows reading "PowerPlants"
// and then offer to delete "Simon" — three spellings of one workspace, and the
// user could not tell which of them any given screen was talking about.
//
// This lives in `shared` rather than in the renderer's file layer for the same
// reason `setting-key.ts` does: the STORE enforces the rule now, and a store
// that invented its own spelling of "which workspace is this file about" would
// disagree with the layer that named the file.

/** What a workspace file is called, and the only extension holding one workspace. */
export const EDB_EXTENSION = '.edb';

/**
 * The project index: this browser's own database, the one that may hold MANY
 * workspaces. A different extension precisely so the invariant above can be read
 * off a file name — while the index was itself called `local.edb`, "a `.edb`
 * holds one workspace" was false of the database the app writes most.
 */
export const EDP_EXTENSION = '.edp';

/**
 * Text → a workspace id.
 *
 * The one rule that turns what a user types into an identifier, and therefore
 * into a file name. Lower case because file names are compared case-insensitively
 * on Windows and two ids differing only in case would be one file; `-` for
 * anything else because it survives a URL, a file name and a SQL string alike.
 *
 * Never empty: `default` is the fallback, which is also the workspace a fresh
 * install boots into.
 */
export function slugifyWorkspace(s: string): string {
  return (
    s
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'default'
  );
}

/**
 * Is this id already exactly what {@link slugifyWorkspace} would produce?
 *
 * The question the STORE asks before accepting a workspace, because only a
 * canonical id maps to a file name and back unchanged. `My Data` is not
 * canonical: it would be written to `My Data.edb`, read back as `my-data`, and
 * the two would then be different workspaces to everything downstream.
 */
export function isCanonicalWorkspaceId(id: string): boolean {
  return id.length > 0 && slugifyWorkspace(id) === id;
}

/** The file name a workspace id maps to. `sales` → `sales.edb`. */
export function spaceFileName(workspaceId: string): string {
  return `${workspaceId}${EDB_EXTENSION}`;
}

/**
 * The workspace a file is about: `a.edb` is the workspace `a`.
 *
 * A path is accepted because an OS open dialog hands back whatever it gave. The
 * stem is slugified rather than trusted, so `My Data.edb` answers `my-data` —
 * the id that file WOULD have if this app had written it.
 */
export function workspaceIdFromFileName(file: string): string {
  const base = file.split(/[\\/]/).pop() ?? file;
  const stem = base.toLowerCase().endsWith(EDB_EXTENSION) ? base.slice(0, -EDB_EXTENSION.length) : base;
  return slugifyWorkspace(stem);
}

/**
 * A stored workspace doc as this version understands it, whoever wrote it.
 *
 * Up to v0.0.504 a workspace carried a third identifier, `name`, and it was what
 * the selector showed when there was no title. Dropping it silently would rename
 * every workspace in every existing file to its id, so the name becomes the
 * TITLE where the doc has none — the field that now does that job.
 *
 * Applied on READ and never written back: a boot that rewrites what it reads
 * marks the workspace unsaved, which this app has already been bitten by
 * (`views-seed`), and the next ordinary write drops the field anyway.
 *
 * Exported because two readers need the same answer — `EdbStore`, and the folder
 * scan, which reads `_easydb` with raw SQL through a throwaway connection and so
 * never passes through the store at all.
 */
export function normalizeWorkspaceDoc(doc: Record<string, unknown>): Record<string, unknown> {
  const { name, ...rest } = doc;
  const kept = typeof rest.title === 'string' && rest.title.trim() ? rest.title : typeof name === 'string' && name.trim() ? name : undefined;
  return kept === undefined ? rest : { ...rest, title: kept };
}

/**
 * A name this app uses for its own throwaway databases, not for a user's file.
 *
 * `__edb-sync-scratch.edb`, `__edb-drop-scratch.edb` and friends: a whole database
 * deserialized from bytes so one workspace can be read out of it, copied into, or
 * renamed, and then thrown away. They end in `.edb` because they ARE that format,
 * but no user ever sees one and none of them is a workspace's file.
 *
 * Reserved rather than guessed: `__` is not a prefix `slugifyWorkspace` can produce
 * from anything a user types through New workspace, and the two names in the app
 * are constants. Without this the store would hold a scratch copy to the rule its
 * throwaway name implies and refuse every sync, drop and in-file rename.
 */
function isInternalDbName(base: string): boolean {
  return base.startsWith('__');
}

/**
 * How many workspaces may live in this database, by its file name.
 *
 * `null` means "any number" — the project index, this app's own scratch copies,
 * and anything this rule does not recognise. A name that is not a `.edb` is not a
 * workspace file, and the store must not invent an invariant for a database it
 * cannot name: a scratch worker opens unnamed databases, and the suites drive the
 * store with no file at all.
 */
export function soleWorkspaceOf(fileName: string | null | undefined): string | null {
  if (!fileName) return null;
  const base = fileName.split(/[\\/]/).pop() ?? fileName;
  if (!base.toLowerCase().endsWith(EDB_EXTENSION)) return null;
  if (isInternalDbName(base)) return null;
  return workspaceIdFromFileName(base);
}
