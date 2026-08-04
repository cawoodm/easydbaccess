// packages/renderer/src/util/ids.ts
//
// Id and slug helpers shared by every table-creating path (importers, the
// paste dialog, the new-table dialog, gist/server sync). Each of these was
// copy-pasted into eight modules before this file existed.
//
// `slugTable` and `slugField` are DIFFERENT functions that were both called
// `slug`. They produce different output and are not interchangeable:
//
//   slugTable('My Table')  -> 'my-table'   (dash, falls back to 'table')
//   slugField('My Column') -> 'my_column'  (underscore, falls back to 'col')
//
// A column `field` must be a safe identifier, because `sql-export` and the
// view templates use it verbatim, hence the underscore form. A table `code`
// is a URL-ish handle, hence the dash form.

/** Random id for a Table or Row. Falls back when `crypto.randomUUID` is absent. */
export function cryptoUUID(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/** Table `code`: lowercase, dash-separated. Empty input yields 'table'. */
export function slugTable(s: string): string {
  return (
    s
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'table'
  );
}

/** Column `field`: lowercase, underscore-separated. Empty input yields 'col'. */
export function slugField(s: string): string {
  return (
    s
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9_]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .replace(/_+/g, '_') || 'col'
  );
}
