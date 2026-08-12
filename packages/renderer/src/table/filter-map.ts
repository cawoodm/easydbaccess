/**
 * `Table.filters` is keyed by FIELD, which makes the columns editor responsible
 * for the keys as well as the columns.
 *
 * A rename has to take the filter with it and a removed column has to lose it.
 * Left alone, the entry names a field no column has — which `db/row-reader.ts`
 * drops on purpose, because such a filter matches nothing and would empty the
 * grid with no visible cause. So nothing breaks loudly; the filter just stops
 * existing without anyone being told. Moving the keys is what keeps a filter
 * doing what the user set it to do.
 */

import type { FieldRename } from './column-merge.js';

/**
 * The filter map after a save: renamed fields carry their filter across, fields
 * no surviving column claims are dropped, and blank expressions are dropped too
 * (an empty filter narrows nothing, so storing it only makes the map lie about
 * which columns are filtered).
 */
export function remapFilterFields(filters: Readonly<Record<string, string>>, renames: readonly FieldRename[], keptFields: ReadonlySet<string>): Record<string, string> {
  const renamed = new Map(renames.map((r) => [r.from, r.to]));
  const out: Record<string, string> = {};
  for (const [field, expr] of Object.entries(filters)) {
    if (!expr || expr.trim() === '') continue;
    const key = renamed.get(field) ?? field;
    if (!keptFields.has(key)) continue;
    out[key] = expr;
  }
  return out;
}

/** Do two filter maps mean the same thing? Used to skip a pointless write. */
export function sameFilterMap(a: Readonly<Record<string, string>>, b: Readonly<Record<string, string>>): boolean {
  const ak = Object.keys(a).filter((k) => (a[k] ?? '').trim() !== '');
  const bk = Object.keys(b).filter((k) => (b[k] ?? '').trim() !== '');
  if (ak.length !== bk.length) return false;
  return ak.every((k) => a[k] === b[k]);
}
