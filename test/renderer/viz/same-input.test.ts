import { describe, expect, it } from 'vitest';
import { sameChartData, sameCloudTerms, sameMapPoints, sameRowRefs, sameVizOptions } from '../../../packages/renderer/src/viz/elements/same-input.js';
import type { ChartData, CloudTerm, MapPoint } from '../../../packages/renderer/src/viz/elements/chart-data.js';

/**
 * The scenario every one of these guards: `viz-panel` rebuilds `terms`, `points`
 * and `data` on every render, so Lit's reference check reports them changed even
 * when the numbers are identical — and a column resized in the grid beside a
 * docked pane is a render. A word cloud then re-ran a main-thread d3-cloud layout
 * and a map re-fit its bounds, throwing away the user's pan.
 */

describe('sameCloudTerms', () => {
  const terms: CloudTerm[] = [
    { term: 'alpha', count: 9 },
    { term: 'beta', count: 4 },
  ];

  it('is true for a new array of the same terms', () => {
    expect(
      sameCloudTerms(
        terms,
        terms.map((t) => ({ ...t })),
      ),
    ).toBe(true);
  });

  it('is false when a count changed', () => {
    expect(
      sameCloudTerms(terms, [
        { term: 'alpha', count: 10 },
        { term: 'beta', count: 4 },
      ]),
    ).toBe(false);
  });

  it('is false when a term changed, was added, or was dropped', () => {
    expect(
      sameCloudTerms(terms, [
        { term: 'alpha', count: 9 },
        { term: 'gamma', count: 4 },
      ]),
    ).toBe(false);
    expect(sameCloudTerms(terms, [...terms, { term: 'gamma', count: 1 }])).toBe(false);
    expect(sameCloudTerms(terms, terms.slice(0, 1))).toBe(false);
  });

  it('is false when the ranking is reordered', () => {
    // The order IS the picture: sizes are scaled over the set and the largest term
    // is what the cloud is read by.
    expect(sameCloudTerms(terms, [...terms].reverse())).toBe(false);
  });

  it('treats two empty sets as the same', () => {
    expect(sameCloudTerms([], [])).toBe(true);
  });
});

describe('sameMapPoints', () => {
  const points: MapPoint[] = [
    { lat: 46.948, lon: 7.4474, label: 'Bern', weight: 3 },
    { lat: 47.3769, lon: 8.5417, label: 'Zurich' },
  ];

  it('is true for a new array of the same points', () => {
    expect(
      sameMapPoints(
        points,
        points.map((p) => ({ ...p })),
      ),
    ).toBe(true);
  });

  it('is false when a coordinate moved, however slightly', () => {
    expect(sameMapPoints(points, [{ ...points[0]!, lat: 46.9481 }, points[1]!])).toBe(false);
  });

  it('is false when a label or a weight changed', () => {
    expect(sameMapPoints(points, [{ ...points[0]!, label: 'Berne' }, points[1]!])).toBe(false);
    expect(sameMapPoints(points, [{ ...points[0]!, weight: 4 }, points[1]!])).toBe(false);
  });

  it('separates a missing weight from a zero one', () => {
    // Not the same marker: no magnitude draws at the floor, a magnitude of zero is
    // a value that was read (see `marker-scale.ts`).
    expect(sameMapPoints([{ lat: 1, lon: 2 }], [{ lat: 1, lon: 2, weight: 0 }])).toBe(false);
  });

  it('is false when the order changed', () => {
    // Radii are assigned by index, so a reordered set is a differently sized set.
    expect(sameMapPoints(points, [...points].reverse())).toBe(false);
  });
});

describe('sameChartData', () => {
  const data: ChartData = {
    categories: ['a', 'b'],
    series: [{ label: 'Count', points: [1, 2] }],
  };
  const copy = (): ChartData => ({ categories: [...data.categories], series: data.series.map((s) => ({ label: s.label, points: [...s.points] })) });

  it('is true for a rebuilt but identical frame', () => {
    expect(sameChartData(data, copy())).toBe(true);
  });

  it('is false when a value, a category or a series label changed', () => {
    const v = copy();
    v.series[0]!.points[1] = 3;
    expect(sameChartData(data, v)).toBe(false);
    const c = copy();
    c.categories[1] = 'c';
    expect(sameChartData(data, c)).toBe(false);
    const l = copy();
    l.series[0]!.label = 'Sum';
    expect(sameChartData(data, l)).toBe(false);
  });

  it('separates a gap from a zero', () => {
    // `spanGaps: false` means a null draws as a hole and a 0 draws as a point on
    // the axis — two different charts.
    const gap = copy();
    gap.series[0]!.points[0] = null;
    const zero = copy();
    zero.series[0]!.points[0] = 0;
    expect(sameChartData(gap, zero)).toBe(false);
  });

  it('is false when a series was added or removed', () => {
    const more = copy();
    more.series.push({ label: 'Other', points: [5, 6] });
    expect(sameChartData(data, more)).toBe(false);
  });

  it('is false against nothing', () => {
    expect(sameChartData(data, null)).toBe(false);
    expect(sameChartData(null, data)).toBe(false);
    expect(sameChartData(null, null)).toBe(true);
  });
});

describe('sameVizOptions', () => {
  it('compares values, not identity', () => {
    expect(sameVizOptions({ minLength: 3, rotate: false }, { minLength: 3, rotate: false })).toBe(true);
    expect(sameVizOptions({ minLength: 3 }, { minLength: 4 })).toBe(false);
  });

  it('notices a key only one side has', () => {
    expect(sameVizOptions({ a: 1 } as Record<string, unknown>, { a: 1, b: 2 })).toBe(false);
  });

  it('treats a key holding undefined as absent', () => {
    // `effectiveVizOptions` merges layers by spread, so an option can appear as an
    // explicit `undefined` in one render and be missing in the next with nothing
    // having been edited.
    expect(sameVizOptions({ a: 1, b: undefined } as Record<string, unknown>, { a: 1 })).toBe(true);
  });

  it('reads a nested value as changed, erring towards redrawing', () => {
    expect(sameVizOptions({ nested: { x: 1 } } as Record<string, unknown>, { nested: { x: 1 } })).toBe(false);
  });
});

describe('sameRowRefs', () => {
  const a = { id: 'r1' };
  const b = { id: 'r2' };

  it('is true for a new array of the same objects', () => {
    expect(sameRowRefs([a, b], [a, b])).toBe(true);
  });

  it('is false for an equal-looking but different object', () => {
    // Identity is the test on purpose: a store write always hands back fresh
    // objects, and deep-comparing 10 000 rows would cost more than the redraw.
    expect(sameRowRefs([a], [{ id: 'r1' }])).toBe(false);
  });

  it('is false on a length or order change', () => {
    expect(sameRowRefs([a, b], [a])).toBe(false);
    expect(sameRowRefs([a, b], [b, a])).toBe(false);
  });
});
