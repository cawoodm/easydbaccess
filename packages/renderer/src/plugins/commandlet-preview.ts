// packages/renderer/src/plugins/commandlet-preview.ts
//
// What `preview/…` means, worked out from the targets alone. Pure: no store, no
// DOM, so the three shapes can be pinned by unit tests rather than by clicking.
//
// The three the user can write:
//
//   preview/notes/Body?Title==Berlin   field named, row chosen by filter
//   preview/notes/n-17                 row chosen by KEY, field chosen for you
//   preview/notes/Body/n-17            both named
//
// The middle one is the reason this module exists. `preview/notes/Body` and
// `preview/notes/n-17` are the same shape — two targets — and only the table's
// own columns can say which was meant. So the rule is: a second target that NAMES
// A COLUMN is a field, and anything else is a key. That makes the common case
// short and leaves the three-target form as the way to be explicit when a key
// happens to be spelled like one of your columns.
//
// "Key" is the FIRST column, assumed to be the primary key. The app has no
// concept of one — no `ColumnSpec.primary`, no uniqueness requirement beyond the
// optional `unique` box — so this is a convention, not a lookup. It is the same
// assumption a person makes reading a table left to right, which is why it is
// worth having; where it is wrong, the filter form says exactly which column to
// match on.

import type { ColumnSpec, Table } from '@easydb/shared';

/** Renderers whose whole purpose is showing a long value in a popup. */
const PREVIEW_RENDERERS = new Set(['preview', 'markdown']);

/** Find a column by field name or label, case-insensitively. `undefined` if none. */
export function findColumn(columns: readonly ColumnSpec[], key: string): ColumnSpec | undefined {
  const want = key.trim().toLowerCase();
  if (!want) return undefined;
  return columns.find((c) => c.field.toLowerCase() === want) ?? columns.find((c) => (c.label ?? '').toLowerCase() === want);
}

/**
 * The column a bare key matches against: the first one.
 *
 * Hidden columns count. A table whose id column is hidden still has that column
 * first, and a key written by `easydb.cmdlet()` in a script came from it.
 */
export function keyColumnOf(table: Pick<Table, 'columns'>): ColumnSpec | undefined {
  return table.columns[0];
}

/**
 * Which field a key-only preview shows, in order of how likely it is to be the
 * thing worth a window:
 *
 *  1. a column with a `preview` or `markdown` renderer — a column someone has
 *     already declared to be too long for its cell,
 *  2. a `text` column — prose, by the type system's own definition,
 *  3. the first column that is not the key — because previewing the key you just
 *     typed tells you nothing,
 *  4. the key column, when that is genuinely all there is.
 *
 * The key column is skipped in 1 and 2 as well: a `text` primary key is unusual
 * enough that a table with one AND a second prose column almost certainly meant
 * the second.
 */
export function previewFieldOf(table: Pick<Table, 'columns'>): ColumnSpec | undefined {
  const columns = table.columns;
  const key = keyColumnOf(table);
  const rest = columns.filter((c) => c !== key);
  return rest.find((c) => c.renderer && PREVIEW_RENDERERS.has(c.renderer)) ?? rest.find((c) => c.type === 'text') ?? rest[0] ?? key;
}

/** What a `preview/…` resolved to, before any row is read. */
export interface PreviewPlan {
  /** The column whose value the window shows. */
  field: ColumnSpec;
  /**
   * A filter to add on top of the commandlet's own, from the key form. Empty
   * when the row was chosen by filters alone.
   */
  keyFilter: Record<string, string>;
}

/**
 * Read the targets after `preview/<table>`.
 *
 * `=` is prefixed to a key so it matches EXACTLY: `column-filter.ts` reads a bare
 * value as "contains", and a key that is a prefix of another key would then pick
 * whichever row sorts first. A key is an identity, so it is matched as one.
 */
export function planPreview(table: Pick<Table, 'columns'>, targets: readonly string[]): PreviewPlan | { error: string } {
  const [first = '', second] = targets;
  const key = keyColumnOf(table);

  // Three targets: field and key, both named. No guessing to do.
  if (second !== undefined) {
    const field = findColumn(table.columns, first);
    if (!field) return { error: `"${first}" is not a column of this table.` };
    if (!key) return { error: 'This table has no columns to match a key against.' };
    return { field, keyFilter: { [key.field]: `=${second}` } };
  }

  // Two targets: a column name means "this field, row from the filters"; anything
  // else is a key, and the field is chosen by `previewFieldOf`.
  const named = findColumn(table.columns, first);
  if (named) return { field: named, keyFilter: {} };

  const field = previewFieldOf(table);
  if (!field) return { error: 'This table has no columns to preview.' };
  if (!key) return { error: 'This table has no columns to match a key against.' };
  return { field, keyFilter: { [key.field]: `=${first}` } };
}
