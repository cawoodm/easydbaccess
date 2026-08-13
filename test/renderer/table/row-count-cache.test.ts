import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cachedRowCount, forgetRowCount, rememberRowCount } from '../../../packages/renderer/src/table/row-count-cache.js';

/**
 * The remembered size of a table, so a big table's titlebar can show its total from
 * the first paint instead of a floor. Counting 609,283 rows in IndexedDB costs 14 s,
 * which is why the number is worth keeping once it has been paid for.
 */

const KEY = 'easydb:rowcounts';

/** A Map-backed localStorage, since these functions read the global one directly. */
function fakeStorage(): Storage {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
    clear: () => m.clear(),
    key: (i: number) => [...m.keys()][i] ?? null,
    get length() {
      return m.size;
    },
  } as Storage;
}

let original: Storage | undefined;

beforeEach(() => {
  original = globalThis.localStorage;
  Object.defineProperty(globalThis, 'localStorage', { value: fakeStorage(), configurable: true });
});

afterEach(() => {
  Object.defineProperty(globalThis, 'localStorage', { value: original, configurable: true });
});

describe('row count cache', () => {
  it('remembers a count and reads it back', () => {
    rememberRowCount('t1', 609_283);
    expect(cachedRowCount('t1')).toBe(609_283);
  });

  it('answers 0 for a table it has never counted', () => {
    expect(cachedRowCount('nope')).toBe(0);
  });

  it('keeps one entry per table', () => {
    rememberRowCount('t1', 10);
    rememberRowCount('t2', 20);
    expect(cachedRowCount('t1')).toBe(10);
    expect(cachedRowCount('t2')).toBe(20);
  });

  it('overwrites an older count for the same table', () => {
    rememberRowCount('t1', 10);
    rememberRowCount('t1', 11);
    expect(cachedRowCount('t1')).toBe(11);
  });

  it('remembers zero — an empty table is a measured size, not a missing one', () => {
    rememberRowCount('t1', 0);
    expect(globalThis.localStorage.getItem(KEY)).toContain('"t1":0');
  });

  it('forgets a table, leaving the others alone', () => {
    rememberRowCount('t1', 10);
    rememberRowCount('t2', 20);
    forgetRowCount('t1');
    expect(cachedRowCount('t1')).toBe(0);
    expect(cachedRowCount('t2')).toBe(20);
  });

  it('ignores a count that is not a usable number', () => {
    rememberRowCount('t1', Number.NaN);
    rememberRowCount('t2', -5);
    expect(cachedRowCount('t1')).toBe(0);
    expect(cachedRowCount('t2')).toBe(0);
  });

  // A cache is not worth a crash: a hand-edited or half-written blob reads as empty.
  it('survives a blob that is not the map it expects', () => {
    globalThis.localStorage.setItem(KEY, '{not json');
    expect(cachedRowCount('t1')).toBe(0);
    globalThis.localStorage.setItem(KEY, '["an","array"]');
    expect(cachedRowCount('t1')).toBe(0);
    globalThis.localStorage.setItem(KEY, '{"t1":"lots"}');
    expect(cachedRowCount('t1')).toBe(0);
  });

  it('ignores an empty table id rather than writing one', () => {
    rememberRowCount('', 5);
    expect(globalThis.localStorage.getItem(KEY)).toBeNull();
  });
});
