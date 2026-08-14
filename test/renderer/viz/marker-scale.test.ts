import { describe, expect, it } from 'vitest';
import { markerRadiusRange, scaleMarkerRadii } from '../../../packages/renderer/src/viz/elements/marker-scale.js';

const pts = (...weights: Array<number | undefined>) => weights.map((weight) => ({ weight }));

describe('scaleMarkerRadii', () => {
  it('spreads the set across the whole range, whatever the absolute values', () => {
    // The bug this replaces: dividing by the MAXIMUM sent a 1.9 against a 6000 to
    // 0.018 of the marker size — below the 2px floor, along with everything else.
    // Normalising over the observed range is what makes the encoding visible.
    const r = scaleMarkerRadii(pts(1.9, 100, 6000), 3, 12);
    expect(r[0]).toBeCloseTo(3, 6);
    expect(r[2]).toBeCloseTo(12, 6);
    // …and the middle value lands strictly between the two.
    expect(r[1]!).toBeGreaterThan(3);
    expect(r[1]!).toBeLessThan(12);
  });

  it('reads magnitude as AREA, so the radius grows with the square root', () => {
    // Four times the weight is twice the radius above the floor, not four times.
    const [a, b] = scaleMarkerRadii(pts(0, 4), 0, 2);
    expect(a).toBeCloseTo(0, 6);
    expect(b).toBeCloseTo(2, 6);
    const mid = scaleMarkerRadii(pts(0, 1, 4), 0, 2)[1];
    expect(mid).toBeCloseTo(1, 6); // sqrt(1)/sqrt(4) = 0.5 of the span
  });

  it('puts an all-equal set in the middle, not at the top', () => {
    // Same judgement as the word cloud: with no differences to show, the size
    // carries no information and must not shout.
    const r = scaleMarkerRadii(pts(5, 5, 5), 4, 10);
    expect(r).toEqual([7, 7, 7]);
  });

  it('gives a point with no weight the minimum, not the middle', () => {
    // At mid-size an empty cell would read as an average quantity rather than as
    // no quantity.
    const r = scaleMarkerRadii(pts(1, undefined, 100), 3, 12);
    expect(r[1]).toBe(3);
  });

  it('treats a non-finite or negative weight as no magnitude at all', () => {
    const r = scaleMarkerRadii(pts(NaN, Infinity, -50, 100), 3, 12);
    expect(r[0]).toBe(3);
    expect(r[1]).toBe(3);
    // Negative is clamped to zero — the point is real, its quantity is not.
    expect(r[2]).toBeCloseTo(3, 6);
    expect(r[3]).toBeCloseTo(12, 6);
  });

  it('falls back to the minimum when nothing carries a weight', () => {
    expect(scaleMarkerRadii(pts(undefined, undefined), 3, 12)).toEqual([3, 3]);
  });

  it('is empty for no points, and tolerates a reversed range', () => {
    expect(scaleMarkerRadii([], 3, 12)).toEqual([]);
    const r = scaleMarkerRadii(pts(1, 4), 12, 3);
    expect(r[0]).toBeCloseTo(3, 6);
    expect(r[1]).toBeCloseTo(12, 6);
  });

  it('returns one radius per point, in order', () => {
    expect(scaleMarkerRadii(pts(1, 2, 3, 4), 2, 10)).toHaveLength(4);
  });
});

describe('markerRadiusRange', () => {
  it('puts the configured size in the middle, so scaling grows AND shrinks', () => {
    // Turning "Size by" on used to only ever shrink markers — the largest kept
    // the unscaled size — which is not what sizing looks like.
    const { min, max } = markerRadiusRange(6);
    expect(min).toBe(3);
    expect(max).toBe(12);
    expect(min).toBeLessThan(6);
    expect(max).toBeGreaterThan(6);
  });

  it('keeps a floor a marker can still be seen at', () => {
    expect(markerRadiusRange(1).min).toBe(2);
    expect(markerRadiusRange(1).max).toBe(4);
  });

  it('falls back to the default size for a missing or nonsense setting', () => {
    for (const bad of [0, -3, NaN, undefined as unknown as number]) {
      expect(markerRadiusRange(bad)).toEqual({ min: 3, max: 12 });
    }
  });
});
