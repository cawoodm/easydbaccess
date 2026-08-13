// packages/shared/src/text-column.ts
//
// "Is this column prose?" — the rule behind the `text` column type.
//
// A `string` column is a name, a code, a status: a short value worth offering in
// a funnel's value list. A `text` column is a description, a body, an abstract —
// values that are each unique and each too long to browse. The two want opposite
// treatment from the filter, so the difference is worth storing on the column
// rather than re-deciding from a sample every time a dropdown opens.
//
// Beside `array-cell.ts` and shaped like it on purpose: same run-of-N evidence,
// same "empty cells are already dropped" contract, same place in each importer's
// inference chain.

/**
 * Shortest value that counts as prose.
 *
 * Deliberately well above `search/facet-values.ts`'s `FACET_MAX_LEN` (50, the
 * length beyond which a value is not offered in a dropdown). That heuristic
 * already covers the borderline column, judged per sample; this threshold
 * decides what gets a TYPE, and a type is a claim about the column that a
 * borderline case should not make.
 */
export const TEXT_MIN_LEN = 120;

/** Consecutive long cells needed as evidence. Mirrors `ARRAY_RUN`. */
export const TEXT_RUN = 5;

/**
 * Is this column prose? True when {@link TEXT_RUN} non-empty cells IN A ROW are
 * all at least `minLen` long, or — for a column with fewer values than that —
 * when every one of them is.
 *
 * A RUN rather than an average, for the reason `looksLikeArrayColumn` uses one:
 * one pasted essay in a column of short labels must not retype the column, and
 * an average is exactly what a single 10 000-character outlier moves.
 *
 * `values` must already have the empty cells dropped — a gap says nothing about
 * whether the column is prose.
 */
export function looksLikeTextColumn(values: readonly unknown[], minLen: number = TEXT_MIN_LEN): boolean {
  if (values.length === 0) return false;
  let run = 0;
  for (const v of values) {
    if (isLongValue(v, minLen)) {
      run++;
      if (run >= TEXT_RUN) return true;
    } else {
      run = 0;
    }
  }
  return values.length < TEXT_RUN && run === values.length;
}

/**
 * Only a real string counts. A number or a boolean is never prose however it
 * prints, and an object's JSON length says something about its shape rather
 * than about the text a reader sees.
 */
function isLongValue(v: unknown, minLen: number): boolean {
  return typeof v === 'string' && v.trim().length >= minLen;
}
