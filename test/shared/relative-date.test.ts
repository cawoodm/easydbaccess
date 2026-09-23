import { describe, expect, it } from 'vitest';
import { resolveDateTerm } from '../../packages/shared/src/relative-date.js';

// A Tuesday, so the week-start case has something to prove.
const NOW = new Date(2026, 8, 23, 14, 30); // 23 Sep 2026, local

describe('resolveDateTerm', () => {
  it('resolves day offsets', () => {
    expect(resolveDateTerm('-7d', NOW)).toBe('2026-09-16');
    expect(resolveDateTerm('-1d', NOW)).toBe('2026-09-22');
  });

  it('resolves week offsets', () => {
    expect(resolveDateTerm('-2w', NOW)).toBe('2026-09-09');
  });

  it('resolves month offsets', () => {
    expect(resolveDateTerm('-3m', NOW)).toBe('2026-06-23');
    expect(resolveDateTerm('-1m', NOW)).toBe('2026-08-23');
  });

  it('clamps a month offset that would overflow a short month', () => {
    // 31 Mar minus one month is 28 Feb, not 3 Mar.
    expect(resolveDateTerm('-1m', new Date(2026, 2, 31))).toBe('2026-02-28');
  });

  it('resolves year offsets', () => {
    expect(resolveDateTerm('-1y', NOW)).toBe('2025-09-23');
    expect(resolveDateTerm('-2y', NOW)).toBe('2024-09-23');
  });

  it('resolves the to-date anchors', () => {
    expect(resolveDateTerm('ytd', NOW)).toBe('2026-01-01');
    expect(resolveDateTerm('qtd', NOW)).toBe('2026-07-01');
    expect(resolveDateTerm('mtd', NOW)).toBe('2026-09-01');
    expect(resolveDateTerm('wtd', NOW)).toBe('2026-09-21'); // Monday
    expect(resolveDateTerm('today', NOW)).toBe('2026-09-23');
  });

  it('is case-insensitive', () => {
    expect(resolveDateTerm('YTD', NOW)).toBe('2026-01-01');
    expect(resolveDateTerm('-3M', NOW)).toBe('2026-06-23');
  });

  it('returns null for anything that is not a relative term', () => {
    expect(resolveDateTerm('2026-01-01', NOW)).toBeNull();
    expect(resolveDateTerm('', NOW)).toBeNull();
    expect(resolveDateTerm('-3x', NOW)).toBeNull();
    expect(resolveDateTerm('3m', NOW)).toBeNull(); // no sign: a literal, not an offset
    expect(resolveDateTerm('tomorrow', NOW)).toBeNull();
  });
});
