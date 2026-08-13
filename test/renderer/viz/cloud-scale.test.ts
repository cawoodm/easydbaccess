import { describe, expect, it } from 'vitest';
import { fitFontCeiling, scaleTermSizes } from '../../../packages/renderer/src/viz/elements/cloud-scale.js';

describe('scaleTermSizes', () => {
  it('maps the extremes onto the range ends', () => {
    const out = scaleTermSizes(
      [
        { term: 'a', count: 100 },
        { term: 'b', count: 1 },
      ],
      10,
      50,
    );
    expect(out[0]?.size).toBe(50);
    expect(out[1]?.size).toBe(10);
  });

  it('sizes every term at the MIDDLE when all counts are equal', () => {
    // The bug this pins, and it was a real one: sizing equal counts at the
    // MAXIMUM meant a column of distinct names or tags (every count 1) made every
    // word the largest, and d3-cloud — which silently drops what it cannot place
    // — rendered 6 of 53 terms. With no differences to show, the size carries no
    // information and must not shout.
    const out = scaleTermSizes(
      [
        { term: 'a', count: 5 },
        { term: 'b', count: 5 },
      ],
      10,
      50,
    );
    expect(out.map((t) => t.size)).toEqual([30, 30]);
  });

  it('does not divide by zero on equal counts', () => {
    for (const t of scaleTermSizes([{ term: 'a', count: 1 }], 12, 40)) expect(Number.isFinite(t.size)).toBe(true);
  });

  it('scales by sqrt, which lifts the middle of a skewed range', () => {
    const out = scaleTermSizes(
      [
        { term: 'a', count: 400 },
        { term: 'b', count: 100 },
        { term: 'c', count: 4 },
      ],
      10,
      50,
    );
    // Roots are 20, 10, 2 ⇒ the middle sits at (10-2)/(20-2) = 0.44 of the range,
    // i.e. 28. A linear scale would put it at (100-4)/396 = 0.24, i.e. 20 — barely
    // above the smallest term despite being 25x its count.
    expect(out[1]?.size).toBe(28);
    expect(out[0]?.size).toBe(50);
    expect(out[2]?.size).toBe(10);
  });

  it('handles a single term and no terms', () => {
    // One term has no range at all, so it takes the midpoint too.
    expect(scaleTermSizes([{ term: 'a', count: 3 }], 10, 50)[0]?.size).toBe(30);
    expect(scaleTermSizes([], 10, 50)).toEqual([]);
  });

  it('preserves term and count alongside the size', () => {
    const out = scaleTermSizes([{ term: 'x', count: 7 }], 10, 50);
    expect(out[0]).toMatchObject({ term: 'x', count: 7 });
  });
});

describe('fitFontCeiling', () => {
  it('shrinks as the term count grows', () => {
    const few = fitFontCeiling(5, 468, 512, 11);
    const many = fitFontCeiling(53, 468, 512, 11);
    const lots = fitFontCeiling(200, 468, 512, 11);
    expect(few).toBeGreaterThan(many);
    expect(many).toBeGreaterThan(lots);
  });

  it('keeps 53 terms in a 468x512 box well under the old fixed ceiling', () => {
    // The reported bug: min(w,h)/5 = 93px for every one of 53 equal terms, of
    // which 6 fit. Anything in this range leaves room for most of them.
    const ceiling = fitFontCeiling(53, 468, 512, 11);
    expect(ceiling).toBeLessThan(40);
    expect(ceiling).toBeGreaterThan(11);
  });

  it('never lets one word fill the box', () => {
    // Even a single term is capped at a fifth of the smaller side.
    expect(fitFontCeiling(1, 400, 300, 11)).toBeLessThanOrEqual(300 / 5);
  });

  it('always leaves a visible step above the floor', () => {
    expect(fitFontCeiling(5000, 100, 80, 11)).toBeGreaterThanOrEqual(15);
  });

  it('survives a zero-sized box', () => {
    expect(Number.isFinite(fitFontCeiling(10, 0, 0, 11))).toBe(true);
  });
});
