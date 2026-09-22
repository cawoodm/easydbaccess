// packages/renderer/src/plugins/commandlet-edit.ts
//
// Which ROW an `edit/…` means, worked out from the targets alone. Pure: no
// store, no DOM, so the three shapes can be pinned by unit tests rather than by
// clicking.
//
// The three the user can write:
//
//   edit/notes?Title==Berlin    row chosen by filters
//   edit/notes/n-17             row chosen by KEY
//   edit/notes/Author/Smith     row chosen by one named field
//
// Unlike `preview`, the two-target form is never ambiguous: `edit` shows the
// whole record, so a lone field name would say nothing about WHICH record. A
// second target is therefore always a key, and a field is only ever read from
// the three-target form.
//
// "Key" is the FIRST column, the same convention `commandlet-preview.ts` uses —
// the app has no `ColumnSpec.primary`, so this is the assumption a person makes
// reading a table left to right. Where it is wrong, the filter form names the
// column.

import type { ColumnSpec, Table } from '@easydb/shared';
import { findColumn, keyColumnOf } from './commandlet-preview.js';

/**
 * The filter the targets after `edit/<table>` add, on top of the commandlet's
 * own query. Empty when the row is chosen by the query alone.
 *
 * `=` is prefixed so a key matches EXACTLY: `column-filter.ts` reads a bare
 * value as "contains", and a key that is a prefix of another key would then open
 * whichever row came back first. A record is an identity, so it is matched as
 * one.
 */
export function planEditKey(table: Pick<Table, 'columns'>, targets: readonly string[]): { keyFilter: Record<string, string> } | { error: string } {
  const [first, second] = targets;

  // Three targets: field and value, both named. No guessing to do.
  if (second !== undefined) {
    const field = findColumn(table.columns, first ?? '');
    if (!field) return { error: `"${first}" is not a column of this table${knownColumns(table.columns)}.` };
    return { keyFilter: { [field.field]: `=${second}` } };
  }

  // Two targets: a key.
  if (first !== undefined && first !== '') {
    const key = keyColumnOf(table);
    if (!key) return { error: 'This table has no columns to match a key against.' };
    return { keyFilter: { [key.field]: `=${first}` } };
  }

  // One target — the table — so the query has to say which row.
  return { keyFilter: {} };
}

function knownColumns(columns: readonly ColumnSpec[]): string {
  const known = columns.map((c) => c.field).join(', ');
  return known ? ` — it has ${known}` : '';
}
