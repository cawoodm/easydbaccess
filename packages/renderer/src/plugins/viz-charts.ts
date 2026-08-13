// packages/renderer/src/plugins/viz-charts.ts
//
// The bar / column / line / pie visualization kinds.
//
// One module, four registrations, and — unlike the cell renderers, which are one
// plugin each — one PLUGIN, because these four share a drawing element, a
// dependency and a mental model. Disabling "pie but not bar" is not a thing
// anybody wants; disabling charts as a whole is. `viz-map` and `viz-wordcloud`
// are separate plugins for the opposite reason: each carries its own library and
// a user may well want one without the other.
//
// Channels are named the same way across kinds on purpose: CATEGORY / VALUE /
// SERIES means a template's mapping survives switching a bar to a line, which is
// the single most common edit a chart gets.

import type { HostApi, SettingsFieldSpec, VizChannelSpec } from '@easydb/shared';

export const meta = {
  id: 'viz-charts',
  name: 'Charts (bar, line, pie)',
  type: 'ui' as const,
  version: '0.1.0',
  description: 'Bar, column, line and pie visualizations of a table, in a window or docked to the grid.',
  icon: 'bar_chart',
};

/** What every categorical chart reads. */
const CATEGORY: VizChannelSpec = {
  key: 'CATEGORY',
  label: 'Category (group by)',
  kind: 'category',
  required: true,
};

const VALUE: VizChannelSpec = {
  key: 'VALUE',
  label: 'Value (measure)',
  kind: 'value',
  // Not restricted to `number`: `count` and `countDistinct` are meaningful over
  // any column, and restricting here would hide the commonest chart of all
  // ("how many rows per category") behind a type change.
};

const SERIES: VizChannelSpec = {
  key: 'SERIES',
  label: 'Split into series (optional)',
  kind: 'series',
};

/** Options shared by the two bar shapes and the line. */
const AXIS_OPTIONS: SettingsFieldSpec[] = [
  { key: 'xTitle', label: 'X axis title', type: 'string' },
  { key: 'yTitle', label: 'Y axis title', type: 'string' },
  { key: 'beginAtZero', label: 'Start the value axis at zero', type: 'boolean', default: true },
  { key: 'legend', label: 'Show the legend', type: 'boolean' },
];

export function init(api: HostApi): void {
  // `count` with no VALUE column is the default because it is the one spec that
  // works on every table the moment a category is picked — a chart that draws
  // nothing until three more choices are made reads as broken.
  const countByCategory = {
    groupBy: ['CATEGORY'],
    measures: [{ channel: 'VALUE', fn: 'count' as const }],
    sort: 'valueDesc' as const,
  };

  api.ui.registerVisualization({
    id: 'bar',
    label: 'Bar chart',
    icon: 'bar_chart',
    tag: 'viz-bar-chart',
    channels: [CATEGORY, VALUE, SERIES],
    data: 'aggregate',
    defaultAggregate: countByCategory,
    options: [...AXIS_OPTIONS, { key: 'stacked', label: 'Stack the bars', type: 'boolean' }],
  });

  api.ui.registerVisualization({
    id: 'column',
    label: 'Column chart',
    icon: 'insert_chart',
    tag: 'viz-column-chart',
    channels: [CATEGORY, VALUE, SERIES],
    data: 'aggregate',
    defaultAggregate: countByCategory,
    options: [...AXIS_OPTIONS, { key: 'stacked', label: 'Stack the columns', type: 'boolean' }],
  });

  api.ui.registerVisualization({
    id: 'line',
    label: 'Line chart',
    icon: 'show_chart',
    tag: 'viz-line-chart',
    channels: [
      // A line's category is usually time, so it says so — but it is not
      // REQUIRED to be a date column: a line over an ordered numeric or textual
      // category is perfectly ordinary.
      { ...CATEGORY, label: 'X axis (group by)', kind: 'time' },
      VALUE,
      SERIES,
    ],
    data: 'aggregate',
    // Category order, not value order: a trend line sorted by size is nonsense.
    defaultAggregate: { ...countByCategory, sort: 'category' },
    options: [
      ...AXIS_OPTIONS,
      { key: 'area', label: 'Fill under the line', type: 'boolean' },
      { key: 'smooth', label: 'Curve the line', type: 'boolean' },
      { key: 'stacked', label: 'Stack the series', type: 'boolean' },
    ],
  });

  api.ui.registerVisualization({
    id: 'pie',
    label: 'Pie chart',
    icon: 'pie_chart',
    tag: 'viz-pie-chart',
    channels: [CATEGORY, VALUE],
    data: 'aggregate',
    // A pie caps itself: forty slices is not a chart, it is a colour wheel. The
    // tail folds into "Other" rather than vanishing.
    defaultAggregate: { ...countByCategory, topN: 8 },
    options: [{ key: 'legend', label: 'Show the legend', type: 'boolean', default: true }],
  });
}
