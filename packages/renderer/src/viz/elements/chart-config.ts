// packages/renderer/src/viz/elements/chart-config.ts
//
// What a bar, column, line or pie LOOKS like: the Chart.js configuration, built
// from neutral data + options + a theme.
//
// Split out of `chart-element.ts` so the styling can be tested without a canvas,
// a DOM or Chart.js itself. Everything here is pure — the element reads the theme
// off its own computed style and passes it in — and, like the rest of this folder,
// it imports nothing from `@easydb/shared` (see `chart-data.ts` for why).
//
// The choices worth knowing, because each one was a chart that looked wrong:
//
//  - **A single series is coloured per CATEGORY.** One flat blue for eight
//    countries is a chart that has to be read off its axis labels; a pie of the
//    same numbers was already coloured per slice, so this also makes the two
//    agree. More than one series goes back to one colour per series, which is
//    the only thing a legend can mean.
//  - **The `topN` tail is drawn grey** (`mutedCategory`). "Other" is not a
//    category the user has, it is everything they did not ask about, and giving
//    it a palette colour let the biggest bar in the chart look like the most
//    interesting one.
//  - **Nothing touches the panel edge.** Chart.js draws to its canvas bounds, so
//    the topmost tick label and the legend sat against the window frame.

import type { ChartConfiguration } from 'chart.js';
import { withAlpha, type ChartData, type ChartTheme } from './chart-data.js';

export type ChartKind = 'bar' | 'column' | 'line' | 'pie';

/** Options a chart element understands. Everything is optional. */
export interface ChartOptions {
  /** Draw the legend. Default: only with more than one series. */
  legend?: boolean | undefined;
  /** Stack bars / areas. */
  stacked?: boolean | undefined;
  /** Fill under a line. */
  area?: boolean | undefined;
  /** Draw a line curved rather than as straight segments. */
  smooth?: boolean | undefined;
  /** Axis titles. */
  xTitle?: string | undefined;
  yTitle?: string | undefined;
  /** Start the value axis at zero even when the data does not. Default true. */
  beginAtZero?: boolean | undefined;
  /**
   * One category to draw in the muted colour instead of a palette one.
   *
   * A single string rather than a list, and that is not laziness: options are
   * compared SHALLOWLY to decide whether a chart needs redrawing
   * (`same-input.ts`), so an array rebuilt per render would read as changed every
   * time and redraw the chart for nothing. There is exactly one such category —
   * the `topN` tail — so a primitive says everything it needs to.
   */
  mutedCategory?: string | undefined;
}

/** Space between the drawing and the panel edge, in px. */
const PAD = 8;

/** Rounded bar ends. Only the value end — a rounded baseline looks like a bug. */
const BAR_RADIUS = 4;

/**
 * A bar wider than this looks like a block of colour rather than a bar. Two
 * categories in a wide window is the case that showed it.
 */
const MAX_BAR = 56;

/** Is this the tail bucket, drawn grey rather than in a palette colour? */
function isMuted(category: string | undefined, options: ChartOptions): boolean {
  return options.mutedCategory !== undefined && options.mutedCategory !== '' && category === options.mutedCategory;
}

/** The colour for one category slot: its palette colour, or grey for the tail. */
function categoryColor(category: string | undefined, index: number, theme: ChartTheme, options: ChartOptions): string {
  if (isMuted(category, options)) return theme.mutedText;
  return theme.palette[index % theme.palette.length] ?? theme.palette[0] ?? '#2563eb';
}

/**
 * One colour per category, or one for the whole series?
 *
 * Per category exactly when there is nothing else to distinguish: one series and
 * bars. With two series the colour IS the series, and a line's colour has to be
 * one colour or the line means nothing.
 */
export function colorsPerCategory(kind: ChartKind, data: ChartData): boolean {
  return (kind === 'bar' || kind === 'column' || kind === 'pie') && data.series.length === 1;
}

/** The datasets, coloured. Exported for the tests; the element goes through `buildChartConfig`. */
export function buildDatasets(kind: ChartKind, data: ChartData, options: ChartOptions, theme: ChartTheme): Record<string, unknown>[] {
  const isPie = kind === 'pie';
  const isLine = kind === 'line';
  const perCategory = colorsPerCategory(kind, data);

  return data.series.map((s, si) => {
    const seriesColor = categoryColor(undefined, si, theme, options);
    if (isPie || perCategory) {
      // Coloured per POINT: a pie's slices are the categories, and a lone bar
      // series has no series to tell apart either.
      const colors = data.categories.map((c, ci) => categoryColor(c, ci, theme, options));
      return {
        label: s.label,
        data: s.points,
        backgroundColor: colors,
        // A slice or bar is separated from its neighbour by the panel's own
        // colour, which reads as a gap rather than as an outline.
        borderColor: theme.surface,
        borderWidth: isPie ? 2 : 0,
        ...(isPie ? { hoverOffset: 6 } : { borderRadius: BAR_RADIUS, borderSkipped: 'start' as const, maxBarThickness: MAX_BAR }),
      };
    }
    if (isLine) {
      return {
        label: s.label,
        data: s.points,
        backgroundColor: withAlpha(seriesColor, options.area ? 0.25 : 0),
        borderColor: seriesColor,
        borderWidth: 2,
        fill: options.area ?? false,
        tension: options.smooth ? 0.35 : 0,
        pointRadius: 2,
        pointHoverRadius: 4,
        // A gap is a gap: joining across a null would draw a value that is not
        // there. `spanGaps: false` is the default but stated here because it is
        // a correctness choice, not styling.
        spanGaps: false,
      };
    }
    return {
      label: s.label,
      data: s.points,
      backgroundColor: seriesColor,
      borderColor: seriesColor,
      borderWidth: 0,
      borderRadius: BAR_RADIUS,
      borderSkipped: 'start' as const,
      maxBarThickness: MAX_BAR,
      spanGaps: false,
    };
  });
}

/** Should the legend be drawn? A legend of one entry names what the reader can already see. */
export function showsLegend(kind: ChartKind, data: ChartData, options: ChartOptions): boolean {
  if (options.legend !== undefined) return options.legend;
  // A pie's legend is its key — the slices carry no labels of their own — but
  // only once there is more than one slice to tell apart.
  if (kind === 'pie') return data.categories.length > 1;
  return data.series.length > 1;
}

/**
 * The whole Chart.js configuration for one chart.
 *
 * `formatNumber` is passed in rather than built here so the element keeps one
 * `Intl.NumberFormat` for the life of the page instead of one per redraw.
 */
export function buildChartConfig(kind: ChartKind, data: ChartData, options: ChartOptions, theme: ChartTheme, formatNumber: (n: number) => string): ChartConfiguration {
  const isPie = kind === 'pie';
  // A horizontal bar is Chart.js's `bar` with `indexAxis: 'y'`; a vertical one
  // ("column" in every spreadsheet ever) is the same type upright.
  const horizontal = kind === 'bar';

  const valueAxis = {
    beginAtZero: options.beginAtZero ?? true,
    stacked: options.stacked ?? false,
    grid: { color: theme.grid, drawTicks: false },
    border: { display: false },
    // Ticks are reference, not content: muted keeps the eye on the bars, and the
    // axis TITLE stays full strength so the units are still legible.
    ticks: { color: theme.mutedText, padding: 6, callback: (v: unknown) => (typeof v === 'number' ? formatNumber(v) : String(v)) },
    title: options.yTitle ? { display: true, text: options.yTitle, color: theme.text, padding: { bottom: 4 } } : { display: false },
  };
  const catAxis = {
    stacked: options.stacked ?? false,
    // No gridlines along the categories: they are labels, not a scale, and a
    // line per category is a cage around the bars.
    grid: { display: false },
    border: { color: theme.grid },
    ticks: { color: theme.text, autoSkip: true, maxRotation: 0, padding: 4 },
    title: options.xTitle ? { display: true, text: options.xTitle, color: theme.text, padding: { top: 4 } } : { display: false },
  };

  return {
    type: isPie ? 'pie' : kind === 'line' ? 'line' : 'bar',
    data: { labels: data.categories, datasets: buildDatasets(kind, data, options, theme) },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      layout: { padding: PAD },
      ...(horizontal ? { indexAxis: 'y' as const } : {}),
      plugins: {
        legend: {
          display: showsLegend(kind, data, options),
          position: 'top' as const,
          // A dot beside a name, not a fat rectangle: the marker only has to say
          // which colour, and the smaller it is the more of the line it leaves.
          labels: { color: theme.text, usePointStyle: true, pointStyle: 'circle' as const, boxWidth: 8, boxHeight: 8, padding: 12 },
        },
        tooltip: {
          enabled: true,
          backgroundColor: withAlpha(theme.text, 0.9),
          padding: 8,
          displayColors: !isPie,
          // The one number a tooltip exists for, grouped the way the axis groups
          // it. Chart.js's default prints a raw `1234.5`.
          callbacks: {
            label: (ctx: { dataset?: { label?: string }; label?: string; parsed?: unknown }) => {
              const parsed = ctx.parsed as number | { x?: number; y?: number } | null;
              const value = typeof parsed === 'number' ? parsed : ((horizontal ? parsed?.x : parsed?.y) ?? null);
              const name = (isPie ? ctx.label : ctx.dataset?.label) ?? '';
              const shown = typeof value === 'number' ? formatNumber(value) : '';
              return name === '' ? shown : `${name}: ${shown}`;
            },
          },
        },
      },
      ...(isPie ? {} : { scales: horizontal ? { x: valueAxis, y: catAxis } : { x: catAxis, y: valueAxis } }),
    },
    // Through `unknown`: the datasets are built as plain records (one shape for
    // four chart types), which Chart.js's per-type dataset union cannot see as
    // compatible even though every key in them is one it declares.
  } as unknown as ChartConfiguration;
}
