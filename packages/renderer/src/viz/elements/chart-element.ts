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
// `@marccawood/lit-dialogs` hand-rolls `defineHostDialogs()`.

import { LitElement, css, html, nothing } from 'lit';
import type { PropertyValues } from 'lit';
import type { Chart as ChartType, ChartConfiguration } from 'chart.js';
import { readChartTheme, type ChartData } from './chart-data.js';
import { buildChartConfig, type ChartKind, type ChartOptions } from './chart-config.js';
import { sameChartData, sameVizOptions } from './same-input.js';

// Both re-exported: the kind and the options are this element's public surface,
// and moving them into `chart-config.ts` (where the styling that reads them
// lives) must not move where a consumer imports them from.
export type { ChartKind, ChartOptions };

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
    m.Chart.register(m.BarController, m.BarElement, m.LineController, m.LineElement, m.PointElement, m.PieController, m.ArcElement, m.CategoryScale, m.LinearScale, m.Tooltip, m.Legend);
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
  /** The input the chart on screen was drawn from — see `same-input.ts`. */
  private drawnData: ChartData = { categories: [], series: [] };
  private drawnOptions: ChartOptions = {};

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
    // `data` is rebuilt by `viz-panel` on every render, so Lit's reference check
    // reports it changed whenever the panel re-renders for a reason that has
    // nothing to do with the numbers — a column resized in the grid beside a
    // docked chart being the case this was found through. Redrawing then replays
    // Chart.js's entry animation over an unchanged chart. See `same-input.ts`.
    if (changed.has('kind') || ((changed.has('data') || changed.has('options')) && !this.matchesDrawn())) void this.draw();
  }

  /** Is the chart on screen already the answer for the current input? */
  private matchesDrawn(): boolean {
    return sameChartData(this.drawnData, this.data) && sameVizOptions(this.drawnOptions, this.options);
  }

  private get hasData(): boolean {
    return this.data.categories.length > 0 && this.data.series.length > 0;
  }

  /**
   * The Chart.js configuration for what is on this element right now.
   *
   * The theme is read here — off this element's own computed style, which is what
   * makes it CSS-themable — and the configuration itself is built by the pure
   * `chart-config.ts`, so the styling can be tested without a canvas.
   */
  private buildConfig(Ctor: typeof ChartType): ChartConfiguration {
    const theme = readChartTheme(this);
    Ctor.defaults.font.family = theme.fontFamily;
    Ctor.defaults.font.size = theme.fontSize;
    Ctor.defaults.color = theme.text;
    return buildChartConfig(this.kind, this.data, this.options, theme, (n) => NUM.format(n));
  }

  private async draw(): Promise<void> {
    const gen = ++this.generation;
    if (!this.hasData) {
      this.chart?.destroy();
      this.chart = null;
      this.rememberDrawnInput();
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
    this.rememberDrawnInput();
  }

  /**
   * Record what the chart on screen was built from.
   *
   * Only where a chart has really been built (or deliberately cleared), never on
   * entry: a run abandoned by the generation guard drew nothing, and remembering
   * its input would suppress the run meant to replace it.
   */
  private rememberDrawnInput(): void {
    this.drawnData = this.data;
    this.drawnOptions = this.options;
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
