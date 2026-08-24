import { describe, expect, it } from 'vitest';
import type { VisualizationSpec, VizAggregate } from '@easydb/shared';
import { carryAggregate, carryOptions, structureFits, switchVizKind } from '../../../packages/renderer/src/viz/viz-kind-switch.js';

/**
 * What survives changing a chart's KIND in the template editor.
 *
 * Nothing did: the editor took the new kind's defaults wholesale, so switching a
 * bar to a column — which reads every single one of the same settings — lost the
 * measure, the axis titles and the group cap. The rule now is one sentence: a
 * setting the user CHANGED travels, a setting they left at the old kind's default
 * follows the new kind's default.
 */

const CATEGORY = { key: 'CATEGORY', label: 'Category', kind: 'category' as const, required: true };
const VALUE = { key: 'VALUE', label: 'Value', kind: 'value' as const };
const SERIES = { key: 'SERIES', label: 'Series', kind: 'series' as const };

const countByCategory: VizAggregate = { groupBy: ['CATEGORY'], measures: [{ channel: 'VALUE', fn: 'count' }], sort: 'valueDesc' };

/** The four chart kinds as `viz-charts.ts` registers them. */
const BAR: VisualizationSpec = {
  id: 'bar',
  label: 'Bar chart',
  tag: 'viz-bar-chart',
  channels: [CATEGORY, VALUE, SERIES],
  data: 'aggregate',
  defaultAggregate: countByCategory,
  options: [
    { key: 'xTitle', label: 'X axis title', type: 'string' },
    { key: 'yTitle', label: 'Y axis title', type: 'string' },
    { key: 'beginAtZero', label: 'Start at zero', type: 'boolean', default: true },
    { key: 'legend', label: 'Show the legend', type: 'boolean' },
    { key: 'stacked', label: 'Stack the bars', type: 'boolean' },
  ],
};
const COLUMN: VisualizationSpec = { ...BAR, id: 'column', label: 'Column chart', tag: 'viz-column-chart' };
const LINE: VisualizationSpec = {
  ...BAR,
  id: 'line',
  label: 'Line chart',
  tag: 'viz-line-chart',
  // Category order, not value order: a trend line sorted by size is nonsense.
  defaultAggregate: { ...countByCategory, sort: 'category' },
};
const PIE: VisualizationSpec = {
  id: 'pie',
  label: 'Pie chart',
  tag: 'viz-pie-chart',
  channels: [CATEGORY, VALUE],
  data: 'aggregate',
  // A pie caps itself: forty slices is a colour wheel, not a chart.
  defaultAggregate: { ...countByCategory, topN: 8 },
  options: [{ key: 'legend', label: 'Show the legend', type: 'boolean', default: true }],
};
const CLOUD: VisualizationSpec = {
  id: 'wordcloud',
  label: 'Word cloud',
  tag: 'viz-word-cloud',
  channels: [{ key: 'TEXT', label: 'Text', kind: 'text' as const, required: true }],
  data: 'rows',
  options: [
    { key: 'minLength', label: 'Shortest word', type: 'number' },
    { key: 'rotate', label: 'Rotate', type: 'boolean' },
  ],
};

describe('the measure', () => {
  it('survives every switch, because it is a question about the data', () => {
    const chosen: VizAggregate = { ...countByCategory, measures: [{ channel: 'VALUE', fn: 'sum' }] };
    expect(carryAggregate(chosen, BAR, COLUMN)?.measures).toEqual([{ channel: 'VALUE', fn: 'sum' }]);
    expect(carryAggregate(chosen, BAR, LINE)?.measures).toEqual([{ channel: 'VALUE', fn: 'sum' }]);
    expect(carryAggregate(chosen, BAR, PIE)?.measures).toEqual([{ channel: 'VALUE', fn: 'sum' }]);
  });

  it('applies to every series, not just the first', () => {
    // Two series counting rows and one summing them is a legend nobody can read.
    const two: VizAggregate = {
      groupBy: ['CATEGORY'],
      measures: [
        { channel: 'VALUE', fn: 'avg' },
        { channel: 'SERIES', fn: 'count' },
      ],
      sort: 'valueDesc',
    };
    expect(carryAggregate(two, BAR, COLUMN)?.measures).toEqual([
      { channel: 'VALUE', fn: 'avg' },
      { channel: 'SERIES', fn: 'avg' },
    ]);
  });
});

describe('the group cap', () => {
  it('travels when the user set it', () => {
    const capped: VizAggregate = { ...countByCategory, topN: 20 };
    expect(carryAggregate(capped, BAR, COLUMN)?.topN).toBe(20);
    expect(carryAggregate(capped, BAR, PIE)?.topN).toBe(20);
  });

  it('does NOT travel off a pie that capped itself', () => {
    // 8 was the pie talking, not the user: carrying it onto a bar would hide
    // data nobody asked to hide.
    const untouched: VizAggregate = { ...countByCategory, topN: 8 };
    expect(carryAggregate(untouched, PIE, BAR)?.topN).toBeUndefined();
  });

  it('keeps a cap the user changed ON a pie', () => {
    const raised: VizAggregate = { ...countByCategory, topN: 30 };
    expect(carryAggregate(raised, PIE, BAR)?.topN).toBe(30);
  });

  it('treats "no cap at all" as the real choice it is', () => {
    // 0 means show every group — see `VizAggregateOverride.topN`.
    const uncapped: VizAggregate = { ...countByCategory, topN: 0 };
    expect(carryAggregate(uncapped, PIE, BAR)?.topN).toBe(0);
    expect(carryAggregate(uncapped, PIE, PIE)?.topN).toBe(0);
  });
});

describe('the order', () => {
  it('follows the new kind when the user never chose one', () => {
    // A bar defaults to largest-first and a line to category order; switching
    // must take the destination's idea, or a trend line comes out in size order.
    expect(carryAggregate(countByCategory, BAR, LINE)?.sort).toBe('category');
    expect(carryAggregate({ ...countByCategory, sort: 'category' }, LINE, BAR)?.sort).toBe('valueDesc');
  });

  it('travels when the user did choose one', () => {
    expect(carryAggregate({ ...countByCategory, sort: 'value' }, BAR, LINE)?.sort).toBe('value');
    expect(carryAggregate({ ...countByCategory, sort: 'valueDesc' }, LINE, BAR)?.sort).toBe('valueDesc');
  });
});

describe('the structure', () => {
  it('carries between kinds that share their channels', () => {
    const split: VizAggregate = { groupBy: ['CATEGORY', 'SERIES'], measures: [{ channel: 'VALUE', fn: 'sum' }], sort: 'valueDesc' };
    expect(carryAggregate(split, BAR, LINE)?.groupBy).toEqual(['CATEGORY', 'SERIES']);
  });

  it('is dropped when the new kind lacks a channel it names', () => {
    // A pie has no SERIES. Keeping the grouping would draw nothing and say
    // nothing about why.
    const split: VizAggregate = { groupBy: ['CATEGORY', 'SERIES'], measures: [{ channel: 'VALUE', fn: 'sum' }], sort: 'valueDesc' };
    expect(structureFits(split, PIE)).toBe(false);
    expect(carryAggregate(split, BAR, PIE)?.groupBy).toEqual(['CATEGORY']);
    // The measure is not structure, so it still comes across.
    expect(carryAggregate(split, BAR, PIE)?.measures).toEqual([{ channel: 'VALUE', fn: 'sum' }]);
  });

  it('carries a bin only when its channel exists in the new kind', () => {
    const binned: VizAggregate = { ...countByCategory, bin: { channel: 'CATEGORY', unit: 'month' } };
    expect(structureFits(binned, LINE)).toBe(true);
    expect(carryAggregate(binned, BAR, LINE)?.bin).toEqual({ channel: 'CATEGORY', unit: 'month' });
    const odd: VizAggregate = { ...countByCategory, bin: { channel: 'SERIES', width: 10 } };
    expect(structureFits(odd, PIE)).toBe(false);
    expect(carryAggregate(odd, BAR, PIE)?.bin).toBeUndefined();
  });

  it('does not mutate the aggregate it was given', () => {
    const prev: VizAggregate = { ...countByCategory, measures: [{ channel: 'VALUE', fn: 'sum' }] };
    carryAggregate(prev, BAR, PIE);
    expect(prev).toEqual({ groupBy: ['CATEGORY'], measures: [{ channel: 'VALUE', fn: 'sum' }], sort: 'valueDesc' });
  });
});

describe('a kind that does not aggregate', () => {
  it('gets no aggregate at all', () => {
    expect(carryAggregate(countByCategory, BAR, CLOUD)).toBeUndefined();
    expect(switchVizKind({ kind: 'bar', aggregate: countByCategory }, BAR, CLOUD).aggregate).toBeUndefined();
  });

  it('gives a chart coming back its own default', () => {
    expect(carryAggregate(undefined, CLOUD, PIE)).toEqual(PIE.defaultAggregate);
  });
});

describe('the options', () => {
  it('keep every value the new kind also declares', () => {
    const opts = { xTitle: 'Country', yTitle: 'Nights', beginAtZero: false, stacked: true };
    expect(carryOptions(opts, COLUMN)).toEqual(opts);
  });

  it('drop what the new kind has no field for', () => {
    // A pie declares only `legend`. Keeping `yTitle` would leave a value in the
    // stored template with nowhere in the editor to see or clear it.
    expect(carryOptions({ yTitle: 'Nights', legend: true, stacked: true }, PIE)).toEqual({ legend: true });
  });

  it('take the new kind seeds for what the user has not set', () => {
    expect(carryOptions({ legend: true }, CLOUD, { minLength: 4 })).toEqual({ minLength: 4 });
    expect(carryOptions({ minLength: 9 }, CLOUD, { minLength: 4 })).toEqual({ minLength: 9 });
  });

  it('ignore a key holding undefined', () => {
    expect(carryOptions({ legend: undefined }, PIE, { legend: true })).toEqual({ legend: true });
  });
});

describe('switchVizKind', () => {
  it('is the whole spec, ready to store', () => {
    const prev = { kind: 'bar', aggregate: { ...countByCategory, measures: [{ channel: 'VALUE', fn: 'sum' as const }], topN: 12 }, options: { yTitle: 'Nights', stacked: true } };
    expect(switchVizKind(prev, BAR, PIE)).toEqual({
      kind: 'pie',
      // The measure and the cap the user chose; the pie's own default order.
      aggregate: { groupBy: ['CATEGORY'], measures: [{ channel: 'VALUE', fn: 'sum' }], sort: 'valueDesc', topN: 12 },
      // `yTitle` and `stacked` mean nothing to a pie.
      options: {},
    });
  });

  it('starts a kind switched into from nothing at its defaults', () => {
    expect(switchVizKind(null, null, PIE, { irrelevant: 1 })).toEqual({ kind: 'pie', aggregate: PIE.defaultAggregate, options: {} });
  });
});
