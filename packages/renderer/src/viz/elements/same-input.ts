// packages/renderer/src/viz/elements/same-input.ts
//
// "Is this the same picture?" — the drawing elements' last line of defence
// against redrawing for nothing.
//
// Lit's dirty check is reference equality, and every one of these properties is
// REBUILT by `viz-panel.render()`: `.terms` comes out of `wordFrequencies`,
// `.points` out of `mapPoints`, `.data` out of `chartData`. So a panel render
// triggered by something that has nothing to do with the data — a column resized
// in the grid beside it, a note appearing, an unrelated field on the instance
// being written — hands the element a brand-new array of identical values, and
// `changed.has('terms')` says yes to all of them.
//
// The redraws that follows are not free, and two of them are actively wrong:
//
//  - `d3-cloud` is an O(terms x placement attempts) layout on the main thread,
//    and re-running it re-places every word;
//  - a map's redraw ends in `fitBounds`, so it throws away wherever the user had
//    panned and zoomed to.
//
// Hence comparison by VALUE here. Everything in this file is pure and imports
// only the neutral shapes from `chart-data.ts` — the folder rule (nothing under
// `viz/elements/` may import `@easydb/shared`) applies to it as much as to the
// elements themselves.

import type { ChartData, CloudTerm, MapPoint } from './chart-data.js';

/** Same terms, same counts, same order. */
export function sameCloudTerms(a: readonly CloudTerm[], b: readonly CloudTerm[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (x?.term !== y?.term || x?.count !== y?.count) return false;
  }
  return true;
}

/**
 * Same points, in the same order.
 *
 * Order matters even though a map is not ordered: `scaleMarkerRadii` returns one
 * radius per point BY INDEX, so a reordered set is a differently drawn set.
 */
export function sameMapPoints(a: readonly MapPoint[], b: readonly MapPoint[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (!x || !y) return false;
    if (x.lat !== y.lat || x.lon !== y.lon || x.label !== y.label || x.weight !== y.weight) return false;
  }
  return true;
}

/** Same categories and the same value in every series slot. */
export function sameChartData(a: ChartData | null | undefined, b: ChartData | null | undefined): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  if (a.categories.length !== b.categories.length || a.series.length !== b.series.length) return false;
  for (let i = 0; i < a.categories.length; i++) {
    if (a.categories[i] !== b.categories[i]) return false;
  }
  for (let s = 0; s < a.series.length; s++) {
    const x = a.series[s];
    const y = b.series[s];
    if (!x || !y || x.label !== y.label || x.points.length !== y.points.length) return false;
    for (let i = 0; i < x.points.length; i++) {
      if (x.points[i] !== y.points[i]) return false;
    }
  }
  return true;
}

/**
 * Same options.
 *
 * SHALLOW, deliberately: an options record is what a settings form produced, so
 * its values are the primitives a form field yields. A nested object would be
 * compared by reference and so read as changed — which errs towards redrawing,
 * the safe direction.
 *
 * `undefined` and absent are the same option here. `effectiveVizOptions` merges
 * layers by spread, so a key can appear holding `undefined` in one render and be
 * missing in the next without the user having changed anything.
 */
export function sameVizOptions<T extends object>(a: Readonly<T>, b: Readonly<T>): boolean {
  if (a === b) return true;
  // Generic in the option type so each element can pass its own (`CloudOptions`,
  // `MapOptions`) without a cast at the call site; the indexing cast lives here.
  const ar = a as Record<string, unknown>;
  const br = b as Record<string, unknown>;
  for (const k of new Set([...Object.keys(ar), ...Object.keys(br)])) {
    if (ar[k] !== br[k]) return false;
  }
  return true;
}

/**
 * Same rows, by REFERENCE per row.
 *
 * For `viz-custom-html`, whose input is the rows themselves rather than anything
 * derived from them. A deep compare of a 10 000-row table would cost more than
 * the redraw it is trying to avoid, and identity is already the right test: a row
 * object is replaced, never mutated, whenever the store is written (see
 * `table/visible-rows.ts`). The exception is a table with SCRIPTED columns, where
 * `evaluatedRows()` builds new objects per render — those keep redrawing as
 * before, which is correct-but-wasteful rather than wrong.
 */
export function sameRowRefs(a: readonly unknown[], b: readonly unknown[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}
