// packages/renderer/src/viz/elements/cloud-scale.ts
//
// Count → font size, and the ceiling that decides how many words actually fit.
//
// In `viz/elements/` rather than beside `viz/word-frequency.ts` because the
// ELEMENT is what needs it, and everything in this folder must be able to travel
// to a standalone package — so it imports nothing from the app (see
// `chart-data.ts`). Pure either way, and unit-tested.

/** One counted term. Structurally the same as `word-frequency.ts`'s `TermCount`. */
export interface SizedTerm {
  term: string;
  count: number;
}

/**
 * Map counts onto a font-size range.
 *
 * Square-root rather than linear: a term appearing 400 times against one
 * appearing 4 is not 100 times more interesting, and a linear scale makes every
 * term but the top one illegible. Area — not height — is what the eye reads as
 * magnitude, and area grows with the square of the font size.
 *
 * **All counts equal ⇒ the MIDDLE of the range, not the top.** This is not a
 * detail: a column of distinct names or tags gives every term a count of 1, and
 * sizing all of them at the maximum produced a cloud where almost nothing fit in
 * the box — `d3-cloud` drops what it cannot place, so 53 equal terms rendered as
 * 6 words. With no differences to show, the size carries no information and
 * should be unremarkable.
 */
export function scaleTermSizes(terms: readonly SizedTerm[], minSize: number, maxSize: number): Array<SizedTerm & { size: number }> {
  if (terms.length === 0) return [];
  const counts = terms.map((t) => t.count);
  const lo = Math.min(...counts);
  const hi = Math.max(...counts);
  return terms.map((t) => {
    const frac = hi === lo ? 0.5 : (Math.sqrt(t.count) - Math.sqrt(lo)) / (Math.sqrt(hi) - Math.sqrt(lo));
    return { ...t, size: Math.round(minSize + frac * (maxSize - minSize)) };
  });
}

/**
 * A font-size ceiling that lets this many terms actually fit a box.
 *
 * `d3-cloud` silently DROPS any word it cannot place, so an over-large ceiling
 * does not produce a crowded cloud — it produces a nearly empty one. Budgeting
 * roughly equal area per term and taking the square root gives a size that
 * scales down as the term count grows, which is the behaviour that keeps a cloud
 * populated. The `0.42` factor is empirical: words are wider than they are tall,
 * so the per-term box is not square.
 */
export function fitFontCeiling(termCount: number, width: number, height: number, minSize: number): number {
  const area = Math.max(1, width) * Math.max(1, height);
  const perTerm = area / Math.max(1, termCount);
  const byArea = Math.sqrt(perTerm) * 0.42;
  // Never larger than a fifth of the smaller side — one word filling the box is
  // not a cloud — and never below the floor plus a visible step.
  const ceiling = Math.min(byArea, Math.min(width, height) / 5);
  return Math.max(minSize + 4, Math.round(ceiling));
}
