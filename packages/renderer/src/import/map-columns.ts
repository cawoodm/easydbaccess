// Mapping an incoming file's columns onto an existing table's columns.
//
// Appending a CSV to a table it did not come from is the case that needs this.
// The append path maps cells onto the target's columns BY POSITION, which is
// right for a file the table was built from and wrong for anything else: one
// extra column at the front and every value lands in the wrong field, silently.
// So the user gets a mapper, and it needs a sensible starting point plus a way
// to apply the answer.
//
// DOM-free, so the dialog stays a thin shell over these two functions.

import type { ColumnSpec } from '@easydb/shared';

/** Per incoming column, the target FIELD it feeds. `''` ⇒ that column is dropped. */
export type ColumnMapping = string[];

const norm = (s: string): string => s.trim().toLowerCase();

/**
 * A first guess at the mapping: an incoming column whose header matches a target
 * column's field or label (ignoring case and surrounding space) feeds it,
 * otherwise the column in the same position, if nothing already claimed it.
 *
 * The position fallback is what the old by-position append did for every column,
 * so a file that used to import correctly still opens with the mapping it had.
 * Each target field is used at most once — two incoming columns cannot both
 * write the same cell.
 */
export function guessMapping(header: readonly string[], targetCols: readonly ColumnSpec[]): ColumnMapping {
  const byName = new Map<string, string>();
  for (const c of targetCols) {
    byName.set(norm(c.field), c.field);
    // A field wins over a label, so a target whose label collides with another
    // target's field does not steal it.
    if (!byName.has(norm(c.label))) byName.set(norm(c.label), c.field);
  }

  const taken = new Set<string>();
  const out: ColumnMapping = header.map(() => '');

  // Name matches first, across the whole header, so they are never blocked by a
  // positional guess made earlier in the row.
  header.forEach((h, i) => {
    const hit = byName.get(norm(h));
    if (hit && !taken.has(hit)) {
      out[i] = hit;
      taken.add(hit);
    }
  });

  header.forEach((_, i) => {
    if (out[i]) return;
    const positional = targetCols[i]?.field;
    if (positional && !taken.has(positional)) {
      out[i] = positional;
      taken.add(positional);
    }
  });

  return out;
}

/**
 * Turn raw string cells into row data for the target table, following `mapping`
 * and coercing each value through its target column's declared type.
 *
 * A target column no incoming column feeds is left ABSENT rather than blanked:
 * on an append that keeps the column's default and, more importantly, does not
 * write an empty over a value the row never mentioned.
 */
export function mapRowsToTarget(
  rows: readonly (readonly string[])[],
  targetCols: readonly ColumnSpec[],
  mapping: ColumnMapping,
  coerce: (raw: string, type: ColumnSpec['type']) => unknown,
): Array<Record<string, unknown>> {
  const typeOf = new Map(targetCols.map((c) => [c.field, c.type] as const));
  return rows.map((cells) => {
    const data: Record<string, unknown> = {};
    mapping.forEach((field, i) => {
      if (!field) return;
      const type = typeOf.get(field);
      if (type === undefined) return; // the column went away since the mapping
      data[field] = coerce(cells[i] ?? '', type);
    });
    return data;
  });
}
