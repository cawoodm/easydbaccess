import { describe, expect, it } from 'vitest';
import { MIN_PANE_W, paneRows, resizedRowWeights, rowOf, rowWeights } from '../../../packages/renderer/src/window-mgr/stack-math.js';

/**
 * Grouping docked panes into ROWS, and dividing a row's width between them.
 *
 * Docking was one pane per band until v0.0.468 — `order` WAS the band — so the
 * compatibility rule is the first thing here: `row` absent means `order`, which
 * is what lets a workspace written before this read back unchanged.
 */

const pane = (order: number, row?: number, weight?: number) => ({ order, ...(row === undefined ? {} : { row }), ...(weight === undefined ? {} : { weight }) });

describe('rowOf', () => {
  it('falls back to order, so an older dock is one pane per row', () => {
    expect(rowOf(pane(0))).toBe(0);
    expect(rowOf(pane(3))).toBe(3);
  });

  it('prefers an explicit row', () => {
    expect(rowOf(pane(3, 0))).toBe(0);
  });
});

describe('paneRows', () => {
  it('gives every pane a row of its own when none says otherwise', () => {
    const rows = paneRows([pane(1), pane(0), pane(2)]);
    expect(rows.map((r) => r.map((p) => p.order))).toEqual([[0], [1], [2]]);
  });

  it('groups panes that share a row, ordered left to right', () => {
    const rows = paneRows([pane(1, 0), pane(0, 0), pane(0, 1)]);
    expect(rows.map((r) => r.map((p) => p.order))).toEqual([[0, 1], [0]]);
  });

  it('renumbers densely, so a row nobody is in does not become an empty band', () => {
    // Row indices are a sort key, not a coordinate — which is what lets a move
    // insert between two rows and leave the normalising to this.
    const rows = paneRows([pane(0, 0), pane(0, 7), pane(1, 7)]);
    expect(rows).toHaveLength(2);
    expect(rows[1]).toHaveLength(2);
  });

  it('sorts by row before order, so a low order in a later row stays later', () => {
    const rows = paneRows([pane(9, 0), pane(0, 1)]);
    expect(rows.map((r) => r.map((p) => p.order))).toEqual([[9], [0]]);
  });

  it('is stable for panes that agree on both', () => {
    const a = pane(0, 0);
    const b = pane(0, 0);
    expect(paneRows([a, b])[0]).toEqual([a, b]);
  });
});

describe('rowWeights', () => {
  it('divides evenly when nothing has been dragged', () => {
    expect(rowWeights([pane(0), pane(1)])).toEqual([0.5, 0.5]);
  });

  it('normalises to 1, so flex-grow shares read as fractions', () => {
    const w = rowWeights([pane(0, 0, 3), pane(1, 0, 1)]);
    expect(w[0]).toBeCloseTo(0.75);
    expect(w[1]).toBeCloseTo(0.25);
  });

  it('gives an unweighted pane an equal share of the row, not zero', () => {
    // A pane with no weight is one nobody has dragged. Zero would be a pane the
    // user cannot see and cannot get back.
    const w = rowWeights([pane(0, 0, 0.5), pane(1)]);
    expect(w[0]).toBeGreaterThan(0);
    expect(w[1]).toBeGreaterThan(0);
  });

  it('ignores a weight that is not a usable number', () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(rowWeights([pane(0, 0, bad), pane(1, 0, 1)]).every((w) => w > 0)).toBe(true);
    }
  });

  it('answers nothing for an empty row', () => {
    expect(rowWeights([])).toEqual([]);
  });
});

describe('resizedRowWeights', () => {
  it('moves width from one pane to its neighbour and nowhere else', () => {
    const [l, r] = resizedRowWeights(0.5, 0.5, 100, 1000);
    expect(l).toBeCloseTo(0.6);
    expect(r).toBeCloseTo(0.4);
    // The pair's combined share is fixed, so the rest of the row cannot reflow.
    expect(l + r).toBeCloseTo(1);
  });

  it('holds both sides above a readable minimum', () => {
    const width = 1000;
    const [l, r] = resizedRowWeights(0.5, 0.5, -10_000, width);
    expect(l * width).toBeGreaterThanOrEqual(MIN_PANE_W - 0.001);
    expect(r * width).toBeLessThanOrEqual(width);
    expect(l + r).toBeCloseTo(1);
  });

  it('splits the pair evenly when the row is too narrow for two minimums', () => {
    const [l, r] = resizedRowWeights(0.5, 0.5, -10_000, MIN_PANE_W);
    expect(l).toBeCloseTo(0.5);
    expect(r).toBeCloseTo(0.5);
  });

  it('leaves the pair alone when there is nothing to measure against', () => {
    expect(resizedRowWeights(0.5, 0.5, 100, 0)).toEqual([0.5, 0.5]);
    expect(resizedRowWeights(0.5, 0.5, Number.NaN, 1000)).toEqual([0.5, 0.5]);
  });
});
