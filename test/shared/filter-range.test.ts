import { describe, expect, it } from 'vitest';
import { composeRange, readRange } from '../../packages/shared/src/filter-range.js';

describe('readRange', () => {
  it('reads a closed range', () => {
    expect(readRange('>=2026-02-14 AND <=2026-08-01')).toEqual({
      from: { value: '2026-02-14', strict: false },
      to: { value: '2026-08-01', strict: false },
      rest: [],
    });
  });

  it('reads an open range', () => {
    expect(readRange('>=-3m')).toEqual({ from: { value: '-3m', strict: false }, rest: [] });
    expect(readRange('<2026-01-01')).toEqual({ to: { value: '2026-01-01', strict: true }, rest: [] });
  });

  it('marks a strict bound', () => {
    expect(readRange('>2026-01-01').from).toEqual({ value: '2026-01-01', strict: true });
  });

  it('a filter with no comparison is all rest', () => {
    const r = readRange('Sweden,!urgent');
    expect(r.from).toBeUndefined();
    expect(r.to).toBeUndefined();
    expect(r.rest).toHaveLength(2);
  });

  it('an empty filter is an empty range', () => {
    expect(readRange('')).toEqual({ rest: [] });
  });

  it('keeps non-range tokens in rest', () => {
    const r = readRange('>=2026-01-01 AND <=2026-06-01,!NULL');
    expect(r.from?.value).toBe('2026-01-01');
    expect(r.to?.value).toBe('2026-06-01');
    expect(r.rest).toEqual([{ term: 'NULL', negate: true }]);
  });

  it('ignores a NEGATED comparison — that is an exclusion, not a bound', () => {
    const r = readRange('!>=2026-01-01');
    expect(r.from).toBeUndefined();
    expect(r.rest).toHaveLength(1);
  });

  it('keeps only the FIRST bound of each side, the rest stay rest', () => {
    const r = readRange('>=2026-01-01,>=2026-05-01');
    expect(r.from?.value).toBe('2026-01-01');
    expect(r.rest).toHaveLength(1);
  });
});

describe('composeRange', () => {
  it('round-trips a closed range', () => {
    const q = '>=2026-02-14 AND <=2026-08-01';
    expect(composeRange(readRange(q))).toBe(q);
  });

  it('round-trips an open range', () => {
    expect(composeRange(readRange('>=-3m'))).toBe('>=-3m');
    expect(composeRange(readRange('<2026-01-01'))).toBe('<2026-01-01');
  });

  it('puts the rest back', () => {
    const q = '>=2026-01-01 AND <=2026-06-01,!NULL';
    expect(composeRange(readRange(q))).toBe(q);
  });

  it('an empty range composes to an empty string', () => {
    expect(composeRange({ rest: [] })).toBe('');
  });

  it('dropping the range leaves the rest as a valid filter', () => {
    const r = readRange('>=2026-01-01 AND <=2026-06-01,!NULL');
    expect(composeRange({ rest: r.rest })).toBe('!NULL');
  });

  it('replacing the range keeps the rest', () => {
    const r = readRange('>=2026-01-01,!NULL');
    expect(composeRange({ from: { value: '-6m', strict: false }, rest: r.rest })).toBe('>=-6m,!NULL');
  });

  it('a to-only range composes without a leading AND', () => {
    expect(composeRange({ to: { value: '2026-08-01', strict: false }, rest: [] })).toBe('<=2026-08-01');
  });
});
