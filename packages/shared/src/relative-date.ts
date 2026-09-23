// packages/shared/src/relative-date.ts
//
// `-3m` → the date three months ago. The relative half of a date filter bound.
//
// Kept relative rather than snapshotted when the user picks it, so a saved view
// still means "the last three months" next month instead of slowly becoming a
// fixed old window. The cost is that the matcher takes a clock — see
// `matchesColumnFilter`'s `now` option.
//
// Everything here works on the LOCAL calendar, because "today" is the reader's
// today. The comparison the result feeds into is UTC-normalised
// (`compare-cell.ts`), which is a deliberate difference: a bound is a calendar
// day the user named, and a cell is an instant that has to agree with SQL.

const OFFSET = /^-(\d+)([dwmy])$/;

/**
 * A relative date term as `YYYY-MM-DD`, or null when the term is not one (in
 * which case the caller uses it literally).
 *
 * | term | means |
 * | --- | --- |
 * | `-7d` `-2w` `-3m` `-1y` | N days / weeks / months / years before today |
 * | `today` | today |
 * | `wtd` `mtd` `qtd` `ytd` | start of this week (Monday) / month / quarter / year |
 */
export function resolveDateTerm(term: string, now: Date): string | null {
  const t = term.trim().toLowerCase();
  if (t === '') return null;

  if (t === 'today') return ymd(now);
  if (t === 'ytd') return ymd(new Date(now.getFullYear(), 0, 1));
  if (t === 'qtd') return ymd(new Date(now.getFullYear(), Math.floor(now.getMonth() / 3) * 3, 1));
  if (t === 'mtd') return ymd(new Date(now.getFullYear(), now.getMonth(), 1));
  if (t === 'wtd') {
    // ISO weeks start on Monday. getDay() is 0 for Sunday, so Sunday is 6 days in.
    const back = (now.getDay() + 6) % 7;
    return ymd(new Date(now.getFullYear(), now.getMonth(), now.getDate() - back));
  }

  const m = OFFSET.exec(t);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2];
  if (unit === 'd') return ymd(new Date(now.getFullYear(), now.getMonth(), now.getDate() - n));
  if (unit === 'w') return ymd(new Date(now.getFullYear(), now.getMonth(), now.getDate() - n * 7));
  if (unit === 'y') return ymd(clampToMonth(now.getFullYear() - n, now.getMonth(), now.getDate()));
  return ymd(clampToMonth(now.getFullYear(), now.getMonth() - n, now.getDate()));
}

/**
 * A date that cannot roll over into the next month.
 *
 * `new Date(2026, 1, 31)` is 3 March, so "one month before 31 March" would come
 * back as 3 March rather than 28 February. The day is clamped to the target
 * month's length instead.
 */
function clampToMonth(year: number, month: number, day: number): Date {
  const probe = new Date(year, month, 1);
  const last = new Date(probe.getFullYear(), probe.getMonth() + 1, 0).getDate();
  return new Date(probe.getFullYear(), probe.getMonth(), Math.min(day, last));
}

/** `YYYY-MM-DD` on the local calendar. */
function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
