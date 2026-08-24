// packages/renderer/src/viz/viz-kind-switch.ts
//
// What survives changing a visualization's KIND — bar to column, bar to pie,
// column to line — in the template editor.
//
// It used to survive nothing: the editor replaced the aggregate and the options
// with the new kind's defaults wholesale. Switching a bar to a column threw away
// the measure, the axis titles and the group cap, although a column chart reads
// every one of them and declares them itself. "Settings common to different chart
// types should not be lost" is the complaint, and it is a fair one.
//
// The rule, and the only one worth remembering:
//
//   **A setting the user CHANGED is carried across. A setting they left at the
//   old kind's default follows the NEW kind's default.**
//
// That second half is what makes the first half safe. A pie caps itself at 8
// slices; carrying that 8 onto a bar chart the user never capped would silently
// hide their data. A line sorts by category; carrying a bar's "largest first"
// onto it would draw a trend line in size order, which is nonsense. In both
// cases the value was the KIND talking, not the user, so it does not travel.
//
// Structure — which channel is the category, which the measure, any binning — is
// carried only when the new kind declares every channel it names. The chart kinds
// deliberately share CATEGORY / VALUE / SERIES so that bar → line keeps the
// mapping (see `plugins/viz-charts.ts`), but a pie has no SERIES, so a chart
// split into series cannot keep that structure when it becomes one.
//
// Pure, so the rule is tested rather than inferred from the editor.

import type { VisualizationSpec, VizAggregate, VizSpec } from '@easydb/shared';
import type { VizOptionValues } from './viz-options.js';

/** The channel keys a kind declares — what its aggregate is allowed to name. */
function channelKeys(spec: VisualizationSpec): Set<string> {
  return new Set(spec.channels.map((c) => c.key));
}

/**
 * Does every channel this aggregate names still exist in the new kind?
 *
 * All of it or none of it: an aggregate grouping by a channel the new kind never
 * heard of does not draw, and half-carrying it (keeping the measures, dropping
 * the grouping) would produce a chart of one bar with no way to tell why.
 */
export function structureFits(agg: VizAggregate, to: VisualizationSpec): boolean {
  const keys = channelKeys(to);
  return agg.groupBy.every((k) => keys.has(k)) && agg.measures.every((m) => keys.has(m.channel)) && (agg.bin === undefined || keys.has(agg.bin.channel));
}

/**
 * The aggregate the new kind starts with, carrying what the user chose.
 *
 * `undefined` when the new kind does not aggregate at all (a map, a word cloud,
 * a block of custom HTML) — there is nothing for the settings to belong to.
 */
export function carryAggregate(prev: VizAggregate | undefined, from: VisualizationSpec | null | undefined, to: VisualizationSpec): VizAggregate | undefined {
  const base = to.defaultAggregate;
  if (!base) return undefined;
  if (!prev) return base;
  const wasDefault = from?.defaultAggregate;

  const out: VizAggregate = structureFits(prev, to)
    ? { ...base, groupBy: [...prev.groupBy], measures: prev.measures.map((m) => ({ ...m })), ...(prev.bin ? { bin: { ...prev.bin } } : {}) }
    : { ...base, measures: base.measures.map((m) => ({ ...m })) };

  // The measure function replaces the function on EVERY measure, exactly as a
  // per-view `fn` override does: a chart asked for "sum" means all of its series,
  // and leaving some of them counting rows is a legend nobody can read.
  const fn = prev.measures[0]?.fn;
  if (fn !== undefined && fn !== wasDefault?.measures?.[0]?.fn) out.measures = out.measures.map((m) => ({ ...m, fn }));
  // Order and the group cap are the two the user reaches for most, and both mean
  // the same thing to every kind that aggregates.
  if (prev.sort !== undefined && prev.sort !== wasDefault?.sort) out.sort = prev.sort;
  if (prev.topN !== undefined && prev.topN !== wasDefault?.topN) out.topN = prev.topN;
  return out;
}

/**
 * The options the new kind starts with: its seeds, then every value the user set
 * that the new kind also declares.
 *
 * Keyed on the DECLARED key, which is what makes this safe to do at all — two
 * kinds that both declare `legend` mean the same thing by it, because the option
 * is rendered by one generic field renderer from one declaration. An option the
 * new kind does not declare is dropped rather than carried invisibly: it would
 * have no field in the editor and would still be in the stored template.
 *
 * The user's value beats a seed. Seeds are workspace defaults for a NEW
 * visualization (see `seedOptions` in `views-dialog.ts`); a value already chosen
 * is not new.
 */
export function carryOptions(prev: VizOptionValues | undefined, to: VisualizationSpec, seeded: VizOptionValues = {}): VizOptionValues {
  const declared = new Set((to.options ?? []).map((o) => o.key));
  const out: VizOptionValues = {};
  // Seeds are filtered by the same rule as carried values, and for the same
  // reason: a key the kind does not declare has no field in the editor, so a
  // value stored under it can never be seen or cleared again.
  for (const [k, v] of [...Object.entries(seeded), ...Object.entries(prev ?? {})]) {
    if (v !== undefined && declared.has(k)) out[k] = v;
  }
  return out;
}

/** The whole `VizSpec` after a kind change — what the editor's select writes. */
export function switchVizKind(prev: VizSpec | null | undefined, from: VisualizationSpec | null | undefined, to: VisualizationSpec, seeded: VizOptionValues = {}): VizSpec {
  return {
    kind: to.id,
    aggregate: carryAggregate(prev?.aggregate, from, to),
    options: carryOptions(prev?.options, to, seeded),
  };
}
