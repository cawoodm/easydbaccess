// packages/renderer/src/viz/elements/chart-element.ts
//
// Bar, line and pie, drawn with Chart.js. One element class behind three tags:
// the three differ only in a Chart.js dataset type and a couple of scale
// choices, so a file each would triplicate the lazy import, the resize handling
// and the accessible fallback.
//
// Two rules this folder lives by (see `chart-data.ts`):
//  - no `@easydb/shared` imports — these files are destined for a standalone
//    package, so they take neutral data and read their theme from CSS;
//  - Chart.js is imported LAZILY and its controllers registered by hand rather
//    than via `chart.js/auto`, so a user who never opens a chart never downloads
//    one, and the bundle carries only the three controllers we draw with.
//
// Custom elements are defined by an explicit guarded `defineCharts()`, never by
// Lit's `@customElement` decorator — a second `define` of the same tag throws,
// which is reachable on an HMR reload or a module evaluated twice. Same reason
// `@cawoodm/lit-dialogs` hand-rolls `defineHostDialogs()`.

import { LitElement, css, html, nothing } from 'lit';
import type { PropertyValues } from 'lit';
import type { Chart as ChartType, ChartConfiguration } from 'chart.js';
import { readChartTheme, withAlpha, type ChartData } from './chart-data.js';

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
}

/** Registered once per page load; Chart.js throws on a duplicate controller id. */
let chartCtorPromise: Promise<typeof ChartType> | null = null;

/**
 * Load Chart.js and register exactly the controllers these three kinds need.
 *
 * Deliberately not `chart.js/auto`: that registers every controller, scale and
 * plugin Chart.js ships, which defeats the tree-shaking and roughly doubles the
 * chunk for no gain here.
 */
async function chartCtor(): Promise<typeof ChartType> {
  if (chartCtorPromise) return chartCtorPromise;
  chartCtorPromise = (async () => {
    const m = await import('chart.js');
    m.Chart.register(
      m.BarController,
      m.BarElement,
      m.LineController,
      m.LineElement,
      m.PointElement,
      m.PieController,
      m.ArcElement,
      m.CategoryScale,
      m.LinearScale,
      m.Tooltip,
      m.Legend,
    );
    return m.Chart;
  })();
  return chartCtorPromise;
}

const NUM = new Intl.NumberFormat();

export class VizChartElement extends LitElement {
  static override styles = css`
    :host {
      display: block;
      position: relative;
      width: 100%;
      height: 100%;
      min-height: 80px;
      container-type: size;
    }
    .wrap {
      position: absolute;
      inset: 0;
    }
    canvas {
      display: block;
      width: 100%;
      height: 100%;
    }
    .empty {
      display: flex;
      align-items: center;
      justify-content: center;
      height: 100%;
      padding: 0.5rem 1rem;
      text-align: center;
      font: 12px/1.5 var(--viz-font-family, system-ui, sans-serif);
      color: var(--viz-muted-text, rgba(127, 127, 127, 0.9));
    }
    /* The accessible equivalent of the canvas. Visually hidden rather than
       display:none, so a screen reader reaches it — a canvas has no readable
       content of its own. Doubles as the copy-the-numbers affordance. */
    .a11y {
      position: absolute;
      width: 1px;
      height: 1px;
      overflow: hidden;
      clip: rect(0 0 0 0);
      clip-path: inset(50%);
      white-space: nowrap;
    }
  `;

  /** Which of the three shapes to draw. Set by each concrete tag. */
  kind: ChartKind = 'bar';

  /** Categories + series. Replaced wholesale on every recompute. */
  data: ChartData = { categories: [], series: [] };

  options: ChartOptions = {};

  /** Shown instead of a chart when there is nothing to draw. */
  emptyText = 'No data to chart.';

  private chart: ChartType | null = null;
  private ro: ResizeObserver | null = null;
  /** Guards against an async draw landing after the element was detached. */
  private generation = 0;

  static override get properties() {
    return {
      kind: { type: String },
      data: { attribute: false },
      options: { attribute: false },
      emptyText: { type: String },
    };
  }

  override connectedCallback(): void {
    super.connectedCallback();
    // Chart.js's own `responsive` handling watches the window, not the element,
    // and a panel splitter resizes the element without resizing the window.
    this.ro = new ResizeObserver(() => this.chart?.resize());
    this.ro.observe(this);
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this.generation++;
    this.ro?.disconnect();
    this.ro = null;
    this.chart?.destroy();
    this.chart = null;
  }

  override updated(changed: PropertyValues): void {
    if (changed.has('data') || changed.has('options') || changed.has('kind')) void this.draw();
  }

  private get hasData(): boolean {
    return this.data.categories.length > 0 && this.data.series.length > 0;
  }

  private buildConfig(Ctor: typeof ChartType): ChartConfiguration {
    const theme = readChartTheme(this);
    const o = this.options;
    const isPie = this.kind === 'pie';
    const isLine = this.kind === 'line';
    const horizontal = this.kind === 'bar';
    const showLegend = o.legend ?? (isPie ? true : this.data.series.length > 1);

    Ctor.defaults.font.family = theme.fontFamily;
    Ctor.defaults.font.size = theme.fontSize;
    Ctor.defaults.color = theme.text;

    const datasets = this.data.series.map((s, i) => {
      const color = theme.palette[i % theme.palette.length] ?? '#2563eb';
      if (isPie) {
        // A pie has one dataset whose SLICES are the categories, so it colours
        // per point rather than per series.
        return {
          label: s.label,
          data: s.points,
          backgroundColor: this.data.categories.map((_, ci) => theme.palette[ci % theme.palette.length] ?? color),
          borderColor: theme.grid,
          borderWidth: 1,
        };
      }
      return {
        label: s.label,
        data: s.points,
        backgroundColor: isLine ? withAlpha(color, o.area ? 0.25 : 0) : color,
        borderColor: color,
        borderWidth: isLine ? 2 : 0,
        fill: isLine ? (o.area ?? false) : false,
        tension: isLine && o.smooth ? 0.35 : 0,
        pointRadius: isLine ? 2 : 0,
        // A gap is a gap: joining across a null would draw a value that is not
        // there. `spanGaps: false` is the default but stated here because it is
        // a correctness choice, not styling.
        spanGaps: false,
      };
    });

    const valueAxis = {
      beginAtZero: o.beginAtZero ?? true,
      stacked: o.stacked ?? false,
      grid: { color: theme.grid },
      border: { color: theme.grid },
      ticks: { color: theme.text, callback: (v: unknown) => (typeof v === 'number' ? NUM.format(v) : String(v)) },
      title: o.yTitle ? { display: true, text: o.yTitle, color: theme.text } : { display: false },
    };
    const catAxis = {
      stacked: o.stacked ?? false,
      grid: { display: false, color: theme.grid },
      border: { color: theme.grid },
      ticks: { color: theme.text, autoSkip: true, maxRotation: 0 },
      title: o.xTitle ? { display: true, text: o.xTitle, color: theme.text } : { display: false },
    };

    return {
      // A horizontal bar is Chart.js's `bar` with `indexAxis: 'y'`; a vertical
      // one ("column" in every spreadsheet ever) is the same type upright.
      type: isPie ? 'pie' : isLine ? 'line' : 'bar',
      data: { labels: this.data.categories, datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        ...(horizontal ? { indexAxis: 'y' as const } : {}),
        plugins: {
          legend: { display: showLegend, labels: { color: theme.text } },
          tooltip: { enabled: true },
        },
        ...(isPie
          ? {}
          : {
              scales: horizontal ? { x: valueAxis, y: catAxis } : { x: catAxis, y: valueAxis },
            }),
      },
    } as ChartConfiguration;
  }

  private async draw(): Promise<void> {
    const gen = ++this.generation;
    if (!this.hasData) {
      this.chart?.destroy();
      this.chart = null;
      return;
    }
    const Ctor = await chartCtor();
    // Awaited above: the element may have been detached, or the data replaced
    // again, while Chart.js was loading.
    if (gen !== this.generation || !this.isConnected) return;
    const canvas = this.renderRoot.querySelector('canvas');
    if (!canvas) return;
    // Rebuilt rather than mutated: a category or series count change makes
    // Chart.js's in-place update paths noticeably fiddlier than a fresh chart,
    // and animation is off so there is nothing to preserve.
    this.chart?.destroy();
    this.chart = new Ctor(canvas, this.buildConfig(Ctor));
  }

  /** One-line summary for `aria-label` — what the picture says, in words. */
  private summary(): string {
    const n = this.data.categories.length;
    const names = this.data.series.map((s) => s.label).join(', ');
    return `${this.kind} chart, ${n} ${n === 1 ? 'category' : 'categories'}${names ? `, showing ${names}` : ''}`;
  }

  override render() {
    if (!this.hasData) return html`<div class="empty">${this.emptyText}</div>`;
    return html`
      <div class="wrap" role="img" aria-label=${this.summary()}>
        <canvas></canvas>
      </div>
      <table class="a11y">
        <caption>
          ${this.summary()}
        </caption>
        <thead>
          <tr>
            <th scope="col">Category</th>
            ${this.data.series.map((s) => html`<th scope="col">${s.label}</th>`)}
          </tr>
        </thead>
        <tbody>
          ${this.data.categories.map(
            (c, i) => html`
              <tr>
                <th scope="row">${c}</th>
                ${this.data.series.map((s) => html`<td>${s.points[i] == null ? '' : NUM.format(s.points[i] as number)}</td>`)}
              </tr>
            `,
          )}
        </tbody>
      </table>
      ${nothing}
    `;
  }
}

/** One subclass per tag, so each tag draws its own shape with no shared state. */
class VizBarChart extends VizChartElement {
  override kind: ChartKind = 'bar';
}
class VizColumnChart extends VizChartElement {
  override kind: ChartKind = 'column';
}
class VizLineChart extends VizChartElement {
  override kind: ChartKind = 'line';
}
class VizPieChart extends VizChartElement {
  override kind: ChartKind = 'pie';
}

/**
 * Register the four tags. Guarded, unlike Lit's `@customElement` decorator: this
 * module can be evaluated twice (an HMR reload, or two bundles on one page) and a
 * second `customElements.define` of the same tag throws.
 */
export function defineCharts(): void {
  const tags: Array<[string, CustomElementConstructor]> = [
    ['viz-bar-chart', VizBarChart],
    ['viz-column-chart', VizColumnChart],
    ['viz-line-chart', VizLineChart],
    ['viz-pie-chart', VizPieChart],
  ];
  for (const [tag, ctor] of tags) if (!customElements.get(tag)) customElements.define(tag, ctor);
}
