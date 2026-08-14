// packages/renderer/src/viz/elements/marker-scale.ts
//
// Weight → marker radius, for the map's "Size by" column.
//
// The sibling of `cloud-scale.ts` and deliberately the same shape: normalise over
// the observed RANGE with a square root, and put an all-equal set in the middle
// of the range rather than at the top. In `viz/elements/` because the element is
// what needs it, so it imports nothing from the app (see `chart-data.ts`). Pure,
// and unit-tested.
//
// **Why it is not a multiplier.** The first version scaled down from the marker
// size: `radius * sqrt(w / maxWeight)`. Two things made that read as "Size by
// does nothing":
//
//  - dividing by the MAXIMUM, on real data, sends almost everything to the floor.
//    A power plant of 1.9 MW against a maximum of 6000 is `sqrt(0.0003)` = 0.018,
//    or a radius of 0.11px — clamped to the 2px minimum, along with every other
//    plant. One marker was 6px and thousands were identical dots;
//  - the largest point got the UNSCALED size, so turning the option on could only
//    ever shrink things. Nothing grew, which is not what "size by" looks like.
//
// Normalising over `[min, max]` instead spreads the set across the whole radius
// range whatever its absolute values, which is what makes the encoding visible.

/** A point that may carry a magnitude. Structurally a subset of `MapPoint`. */
export interface WeightedPoint {
  weight?: number | undefined;
}

/** Is this a usable magnitude? A missing or non-finite weight is not. */
function magnitude(w: number | undefined): number | null {
  if (typeof w !== 'number' || !Number.isFinite(w)) return null;
  // A negative magnitude has no size to draw. Clamped rather than dropped: the
  // point is still real, it just carries no positive quantity.
  return Math.max(0, w);
}

/**
 * The radius for each point, in the order given.
 *
 * Square-root, for the reason `cloud-scale.ts` gives: AREA is what the eye reads
 * as magnitude, and area grows with the square of the radius — so a linear radius
 * exaggerates the large values by squaring them a second time.
 *
 * **All weights equal ⇒ the middle of the range.** With no differences to show
 * the size carries no information, and drawing every marker at the maximum says
 * the opposite. Same judgement, same reason as the word cloud.
 *
 * **A point with no weight gets the MINIMUM.** It cannot be left at the unscaled
 * size: that is mid-range, so a row with the column empty would read as an
 * average-sized quantity rather than as no quantity at all.
 */
export function scaleMarkerRadii(points: readonly WeightedPoint[], minRadius: number, maxRadius: number): number[] {
  const lo = Math.min(minRadius, maxRadius);
  const hi = Math.max(minRadius, maxRadius);
  const weights = points.map((p) => magnitude(p.weight)).filter((w): w is number => w !== null);
  if (weights.length === 0) return points.map(() => lo);
  const wLo = Math.min(...weights);
  const wHi = Math.max(...weights);
  const rootLo = Math.sqrt(wLo);
  const rootHi = Math.sqrt(wHi);
  const span = rootHi - rootLo;
  return points.map((p) => {
    const w = magnitude(p.weight);
    if (w === null) return lo;
    const frac = span === 0 ? 0.5 : (Math.sqrt(w) - rootLo) / span;
    return lo + frac * (hi - lo);
  });
}

/**
 * The radius range to scale into, from the configured marker size.
 *
 * The setting is one number ("Marker size (px)") and means the size markers have
 * when nothing is scaling them, so scaling has to derive a range from it. Half to
 * double puts that size in the middle: switching "Size by" on makes the small
 * ones smaller AND the large ones larger, so the change is visible in both
 * directions rather than looking like everything shrank.
 */
export function markerRadiusRange(baseRadius: number): { min: number; max: number } {
  const base = Number.isFinite(baseRadius) && baseRadius > 0 ? baseRadius : 6;
  return { min: Math.max(2, base * 0.5), max: Math.max(4, base * 2) };
}
