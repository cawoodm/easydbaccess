// packages/renderer/src/util/local-datetime.ts
//
// Showing a stored date or datetime the way its reader writes one.
//
// The one distinction that matters, and the reason this is not a one-liner:
//
//   * a value carrying a ZONE (`2026-06-17T10:59:56.937Z`, `…+02:00`) names an
//     INSTANT, so it must be converted to the reader's clock — 10:59Z is 12:59 in
//     Zurich, and showing "10:59" there is simply the wrong time;
//   * a value carrying NO zone (`2026-06-17 10:59`, `2026-06-17`) is a WALL CLOCK
//     already, so converting it would invent a shift. A meeting stored as 09:00
//     is at 09:00 wherever it is read.
//
// Both go through `Intl`, so the order of the parts and the separators are the
// reader's too. Display only: nothing here is ever written back, and sorting and
// filtering keep working on the stored string.

/** Does the text name an instant (carries a timezone) rather than a wall clock? */
export function hasTimezone(s: string): boolean {
  return /(?:Z|[+-]\d{2}:?\d{2})$/i.test(s.trim());
}

/** A trimmed string for anything worth formatting, else null. */
function text(value: unknown): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const s = String(value).trim();
  return s === '' ? null : s;
}

/** `YYYY-MM-DD` (and the date half of a datetime) without going through `Date`. */
const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
const NAIVE = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/;

/**
 * A `date` column's value as the reader writes a date.
 *
 * A date-only value is formatted from its PARTS, never through `new Date(s)`:
 * `new Date('2026-06-17')` is parsed as midnight UTC, so west of Greenwich it
 * renders as the 16th. That off-by-one-day is the classic date bug and this is
 * where it is avoided.
 */
export function formatDateLocal(value: unknown, locale?: string): string {
  const s = text(value);
  if (s === null) return '';
  const d = DATE_ONLY.exec(s);
  if (d) return localDate(new Date(Number(d[1]), Number(d[2]) - 1, Number(d[3])), locale);
  const naive = NAIVE.exec(s);
  if (naive && !hasTimezone(s)) return localDate(new Date(Number(naive[1]), Number(naive[2]) - 1, Number(naive[3])), locale);
  const parsed = new Date(s);
  return Number.isNaN(parsed.getTime()) ? s : localDate(parsed, locale);
}

/**
 * A `datetime` column's value as the reader writes one: converted from the
 * instant when the value carries a zone, shown as stored when it does not.
 *
 * An unparseable value comes back UNCHANGED rather than blank — a value the app
 * cannot read is still the user's data, and hiding it is how a bad cell looks
 * like an empty one.
 */
export function formatDateTimeLocal(value: unknown, locale?: string): string {
  const s = text(value);
  if (s === null) return '';
  const naive = NAIVE.exec(s);
  if (naive && !hasTimezone(s)) {
    // No zone: keep the clock exactly as stored, only re-order it for the reader.
    const d = new Date(Number(naive[1]), Number(naive[2]) - 1, Number(naive[3]), Number(naive[4]), Number(naive[5]), Number(naive[6] ?? 0));
    return localDateTime(d, locale);
  }
  if (DATE_ONLY.test(s)) return formatDateLocal(s, locale);
  const parsed = new Date(s);
  return Number.isNaN(parsed.getTime()) ? s : localDateTime(parsed, locale);
}

function localDate(d: Date, locale?: string): string {
  return d.toLocaleDateString(locale);
}

function localDateTime(d: Date, locale?: string): string {
  // Seconds are dropped on purpose: a grid or a card is read at a glance, and
  // `…:56.937` is noise in every case this exists to fix.
  return `${d.toLocaleDateString(locale)} ${d.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })}`;
}

/** Format by COLUMN TYPE, or `null` when the type is not a date one. */
export function formatByType(type: string | undefined, value: unknown, locale?: string): string | null {
  if (type === 'date') return formatDateLocal(value, locale);
  if (type === 'datetime') return formatDateTimeLocal(value, locale);
  return null;
}
