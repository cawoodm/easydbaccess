import { describe, expect, it } from 'vitest';
import { orderForRestack, type ZOrderCandidate } from './z-order.js';

const c = (id: string, z: number | undefined, minimized = false): ZOrderCandidate => ({
  id,
  z,
  minimized,
});

describe('orderForRestack', () => {
  it('orders interleaved tables and views ascending by z, regardless of kind', () => {
    // table1 (z=10) < view1 (z=20) < table2 (z=30) — the exact interleaving
    // that a per-kind sort cannot reproduce (see restack.ts module doc).
    const ordered = orderForRestack([c('table2', 30), c('table1', 10), c('view1', 20)]);
    expect(ordered).toEqual(['table1', 'view1', 'table2']);
  });

  it('treats undefined z as oldest (sorts first)', () => {
    const ordered = orderForRestack([c('a', 5), c('b', undefined), c('c', 1)]);
    expect(ordered).toEqual(['b', 'c', 'a']);
  });

  it('keeps input order for equal z (stable sort)', () => {
    const ordered = orderForRestack([c('a', 5), c('b', 5), c('c', 5)]);
    expect(ordered).toEqual(['a', 'b', 'c']);
  });

  it('excludes minimized entries entirely', () => {
    const ordered = orderForRestack([c('a', 1), c('b', 2, true), c('c', 3)]);
    expect(ordered).toEqual(['a', 'c']);
  });

  it('returns an empty list when everything is minimized', () => {
    expect(orderForRestack([c('a', 1, true), c('b', 2, true)])).toEqual([]);
  });

  it('does not mutate the input array', () => {
    const input = [c('a', 3), c('b', 1)];
    const copy = [...input];
    orderForRestack(input);
    expect(input).toEqual(copy);
  });
});
