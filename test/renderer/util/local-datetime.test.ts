import { describe, expect, it } from 'vitest';
import { formatByType, formatDateLocal, formatDateTimeLocal, hasTimezone } from '../../../packages/renderer/src/util/local-datetime.js';

/**
 * The distinction the module exists for: a value with a ZONE names an instant and
 * must be converted to the reader's clock; a value WITHOUT one is already a wall
 * clock and must not be shifted.
 *
 * Expectations are built with `toLocaleDateString` rather than pinned to a
 * separator — the point is that the output is the reader's format, whatever that
 * is, so hard-coding `17.06.2026` would only assert the test machine's locale.
 */
describe('local-datetime', () => {
  const EN = 'en-GB';

  it('spots a timezone in the spellings that carry one', () => {
    expect(hasTimezone('2026-06-17T10:59:56.937Z')).toBe(true);
    expect(hasTimezone('2026-06-17T10:59+02:00')).toBe(true);
    expect(hasTimezone('2026-06-17T10:59-0500')).toBe(true);
    expect(hasTimezone('2026-06-17T10:59')).toBe(false);
    expect(hasTimezone('2026-06-17')).toBe(false);
  });

  it('a date-only value keeps its day, whatever the reader zone', () => {
    // `new Date('2026-06-17')` is midnight UTC, which renders as the 16th west of
    // Greenwich. Formatting from the PARTS is what avoids that off-by-one-day.
    expect(formatDateLocal('2026-06-17', EN)).toBe(new Date(2026, 5, 17).toLocaleDateString(EN));
    expect(formatDateLocal('2026-06-17', EN)).toContain('17');
    expect(formatDateLocal('2026-06-17', EN)).not.toContain('16');
  });

  it('a zoned datetime is converted to the reader clock', () => {
    const iso = '2026-06-17T10:59:56.937Z';
    const d = new Date(iso);
    expect(formatDateTimeLocal(iso, EN)).toBe(`${d.toLocaleDateString(EN)} ${d.toLocaleTimeString(EN, { hour: '2-digit', minute: '2-digit' })}`);
    // The seconds and the milliseconds are gone, which is the reported symptom.
    expect(formatDateTimeLocal(iso, EN)).not.toContain('56');
    expect(formatDateTimeLocal(iso, EN)).not.toContain('937');
    expect(formatDateTimeLocal(iso, EN)).not.toContain('Z');
  });

  it('an unzoned datetime is shown as stored — no invented shift', () => {
    // A meeting stored as 09:00 is at 09:00 wherever it is read.
    expect(formatDateTimeLocal('2026-06-17T09:00', EN)).toContain('09:00');
    expect(formatDateTimeLocal('2026-06-17 09:00:30', EN)).toContain('09:00');
    expect(formatDateTimeLocal('2026-06-17T09:00', EN)).toBe(`${new Date(2026, 5, 17).toLocaleDateString(EN)} 09:00`);
  });

  it('a datetime column holding only a date shows just the date', () => {
    expect(formatDateTimeLocal('2026-06-17', EN)).toBe(formatDateLocal('2026-06-17', EN));
  });

  it('empty stays empty, and an unreadable value comes back unchanged', () => {
    for (const v of [null, undefined, '', '   ', {}, []]) {
      expect(formatDateLocal(v)).toBe('');
      expect(formatDateTimeLocal(v)).toBe('');
    }
    // The user's data, even if the app cannot read it — blanking it would make a
    // bad cell look like an empty one.
    expect(formatDateTimeLocal('not a date', EN)).toBe('not a date');
    expect(formatDateLocal('tomorrow?', EN)).toBe('tomorrow?');
  });

  it('formatByType only answers for the two date types', () => {
    expect(formatByType('date', '2026-06-17', EN)).toBe(formatDateLocal('2026-06-17', EN));
    expect(formatByType('datetime', '2026-06-17T09:00', EN)).toBe(formatDateTimeLocal('2026-06-17T09:00', EN));
    expect(formatByType('string', '2026-06-17', EN)).toBeNull();
    expect(formatByType(undefined, '2026-06-17', EN)).toBeNull();
    expect(formatByType('number', 42, EN)).toBeNull();
  });
});
