import type { SortSpec } from '@easydb/shared';

/**
 * What a click on a column header does to the sort keys. Pure, so the rule can
 * be read and tested without a grid.
 *
 * The cycle for the column clicked is: first direction → the other one → off.
 * Which direction comes FIRST is a setting (`grid:sortDescFirst`), because it
 * depends on the data: with a date, a score or a count — anything where "the
 * interesting end" is the high end — ascending first means every sort takes two
 * clicks. With a name it is the opposite.
 *
 * `additive` (shift-click) keeps the keys already in place and works on this
 * column behind them, so "city, then age descending" is two clicks. A plain
 * click drops the others: the common case is one column, and having to clear
 * leftover keys first would be worse than losing them.
 */
export function nextSortSpecs(
  current: readonly SortSpec[],
  field: string,
  opts: { additive?: boolean | undefined; descFirst?: boolean | undefined } = {},
): SortSpec[] {
  const additive = opts.additive === true;
  const firstAsc = opts.descFirst !== true;
  const existing = current.find((s) => s.field === field);
  const isOnlyKey = current.length === 1 && current[0]?.field === field;

  // A plain click on a column that is NOT already the only key means "sort by
  // this instead": it becomes the sole key, in the first direction. Only when it
  // is already alone does the click walk the cycle on — otherwise dropping the
  // other keys would land on "unsorted" unexpectedly.
  if (!additive && !isOnlyKey) return [{ field, asc: firstAsc }];

  const others = additive ? current.filter((s) => s.field !== field) : [];
  // Untouched → first direction; already in the first direction → the other one;
  // already in the other → gone (it simply stays out of the result).
  if (!existing) return [...others, { field, asc: firstAsc }];
  if (existing.asc === firstAsc) return [...others, { field, asc: !firstAsc }];
  return [...others];
}
