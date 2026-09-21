import { describe, expect, it } from 'vitest';
import { inferColumnType, isDateShape, isDateTimeShape } from '../../../packages/renderer/src/import/infer-type.js';

/** The CSV footing: every value arrives as text, so spellings count. */
const RAW = { raw: true } as const;

describe('isDateShape', () => {
  it('accepts ISO and D/M/Y with any of the three separators', () => {
    expect(isDateShape('2026-01-31')).toBe(true);
    expect(isDateShape('31/01/2026')).toBe(true);
    expect(isDateShape('31-01-2026')).toBe(true);
    expect(isDateShape('31.01.26')).toBe(true);
  });

  it('refuses a bare number, so a column of years or IDs is not a date', () => {
    expect(isDateShape('2026')).toBe(false);
    expect(isDateShape('19700101')).toBe(false);
  });

  it('refuses a date that carries a time — that is a datetime', () => {
    expect(isDateShape('2026-01-31T10:30')).toBe(false);
  });

  it('refuses a URL, which V8 would have parsed as a date', () => {
    expect(isDateShape('https://example.com/1')).toBe(false);
  });
});

describe('isDateTimeShape', () => {
  it('needs a time after a space or a T', () => {
    expect(isDateTimeShape('2026-01-31T10:30')).toBe(true);
    expect(isDateTimeShape('2026-01-31 10:30:59')).toBe(true);
    expect(isDateTimeShape('31/01/2026 10:30')).toBe(true);
  });

  it('is false for a date with no time', () => {
    expect(isDateTimeShape('2026-01-31')).toBe(false);
  });
});

describe('inferColumnType', () => {
  it('is string when there is nothing to go on', () => {
    expect(inferColumnType([])).toBe('string');
    expect(inferColumnType([null, undefined, ''])).toBe('string');
  });

  it('ignores empty cells when typing the rest', () => {
    expect(inferColumnType([1, null, 2, ''])).toBe('number');
  });

  describe('already-typed values (JSON, Datasette)', () => {
    it('reads the JS types', () => {
      expect(inferColumnType([1, 2.5, -3])).toBe('number');
      expect(inferColumnType([true, false])).toBe('boolean');
      expect(inferColumnType([['a'], ['b']])).toBe('array');
    });

    it('does NOT read a numeric string as a number', () => {
      expect(inferColumnType(['1', '2'])).toBe('string');
    });

    it('does NOT read 0/1 as boolean — in JSON those are numbers', () => {
      expect(inferColumnType([0, 1, 0])).toBe('number');
    });

    it('refuses a non-finite number', () => {
      expect(inferColumnType([1, Number.NaN])).toBe('string');
    });
  });

  describe('raw text values (CSV)', () => {
    it('reads numeric strings as numbers', () => {
      expect(inferColumnType(['1', '2.5', '-3'], RAW)).toBe('number');
    });

    it('reads the spellings of a boolean', () => {
      expect(inferColumnType(['true', 'FALSE'], RAW)).toBe('boolean');
      expect(inferColumnType(['yes', 'no'], RAW)).toBe('boolean');
      expect(inferColumnType(['0', '1'], RAW)).toBe('boolean');
    });

    it('keeps an integer too big for a JS number out of a number column', () => {
      expect(inferColumnType(['9007199254740993'], RAW)).toBe('string');
    });
  });

  describe('dates — the three importers used to disagree here', () => {
    it('types a time-carrying column datetime, whatever the format', () => {
      // JSON used to call this `date`; Datasette got it right only for ISO.
      expect(inferColumnType(['2026-01-31T10:30', '2026-02-01T11:00'])).toBe('datetime');
      expect(inferColumnType(['2026-01-31T10:30'], RAW)).toBe('datetime');
    });

    it('types a date-only column date, whatever the format', () => {
      // Datasette used to call this `datetime` — its regex made the time optional.
      expect(inferColumnType(['2026-01-31', '2026-02-01'])).toBe('date');
      expect(inferColumnType(['2026-01-31'], RAW)).toBe('date');
    });

    it('reads D/M/Y, which Datasette used to leave as a string', () => {
      expect(inferColumnType(['31/01/2026', '01/02/2026'])).toBe('date');
    });

    it('leaves a column of URLs alone', () => {
      expect(inferColumnType(['https://example.com/1', 'https://example.com/2'])).toBe('string');
    });

    it('does not type a mixed column', () => {
      expect(inferColumnType(['2026-01-31', 'not a date'])).toBe('string');
    });
  });

  describe('the ladder order', () => {
    it('prefers array over everything', () => {
      expect(inferColumnType([['1'], ['2']])).toBe('array');
    });

    it('prefers datetime over date, so a time is never dropped', () => {
      expect(inferColumnType(['2026-01-31T10:30'])).toBe('datetime');
    });

    it('falls to text only for long values, after the typed branches', () => {
      const long = 'x'.repeat(400);
      expect(inferColumnType([long, long])).toBe('text');
      // A number stays a number however many of them there are.
      expect(inferColumnType([1, 2, 3])).toBe('number');
    });
  });
});
