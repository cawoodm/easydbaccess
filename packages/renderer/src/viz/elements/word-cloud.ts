// packages/renderer/src/viz/elements/word-cloud.ts
//
// `<viz-word-cloud>` — terms sized by frequency, placed with `d3-cloud` and drawn
// into our own SVG.
//
// `d3-cloud` is a LAYOUT, not a renderer: it hands back a position, size and
// rotation per word and draws nothing. That is exactly what is wanted here —
// the SVG is ours, so it themes with the same CSS variables as every other
// element and a term can be a real `<text>` node rather than a canvas blob (which
// no screen reader and no text search can reach).
//
// The layout is O(terms x placement attempts) on the main thread, so the term
// count is capped by the caller and the run is generation-guarded: a resize while
// a layout is in flight abandons the old one rather than drawing it late.

import { LitElement, css, html, nothing } from 'lit';
import type { PropertyValues } from 'lit';
import { readChartTheme, type CloudTerm } from './chart-data.js';

export interface CloudOptions {
  minFontSize?: number | undefined;
  maxFontSize?: number | undefined;
  /** Allow 90° rotated words. Default false — horizontal is markedly more readable. */
  rotate?: boolean | undefined;
}

/** One laid-out word, as d3-cloud returns it. */
interface PlacedWord {
  text: string;
  size: number;
  x: number;
  y: number;
  rotate: number;
  count: number;
}

export class VizWordCloud extends LitElement {
  static override styles = css`
    :host {
      display: block;
      position: relative;
      height: 100%;
      min-height: 100px;
    }
    svg {
      display: block;
      width: 100%;
      height: 100%;
    }
    text {
      font-family: var(--viz-font-family, system-ui, sans-serif);
      font-weight: 600;
      cursor: default;
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
  `;

  terms: CloudTerm[] = [];
  options: CloudOptions = {};
  emptyText = 'No words to show.';

  private placed: PlacedWord[] = [];
  private w = 0;
  private h = 0;
  private generation = 0;
  private ro: ResizeObserver | null = null;

  static override get properties() {
    return {
      terms: { attribute: false },
      options: { attribute: false },
      emptyText: { type: String },
      placed: { state: true },
    };
  }

  override connectedCallback(): void {
    super.connectedCallback();
    this.ro = new ResizeObserver(() => {
      // A layout is bound to the box it was computed for, so a resize has to
      // re-run it rather than rescale the result.
      const r = this.getBoundingClientRect();
      if (Math.abs(r.width - this.w) < 8 && Math.abs(r.height - this.h) < 8) return;
      void this.layout();
    });
    this.ro.observe(this);
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this.generation++;
    this.ro?.disconnect();
    this.ro = null;
  }

  override updated(changed: PropertyValues): void {
    if (changed.has('terms') || changed.has('options')) void this.layout();
  }

  private async layout(): Promise<void> {
    const gen = ++this.generation;
    if (this.terms.length === 0) {
      this.placed = [];
      return;
    }
    const rect = this.getBoundingClientRect();
    const w = Math.max(80, Math.floor(rect.width));
    const h = Math.max(60, Math.floor(rect.height));
    const mod = await import('d3-cloud');
    if (gen !== this.generation || !this.isConnected) return;
    const cloud = (mod.default ?? mod) as unknown as () => CloudLayout;

    const counts = this.terms.map((t) => t.count);
    const lo = Math.min(...counts);
    const hi = Math.max(...counts);
    const minF = this.options.minFontSize ?? 12;
    const maxF = this.options.maxFontSize ?? Math.max(minF + 6, Math.floor(Math.min(w, h) / 5));
    // Same sqrt scale as `word-frequency.ts`'s `scaleTermSizes`, applied here
    // because the size range depends on the box, which that pure module cannot see.
    const sizeOf = (c: number): number => {
      const frac = hi === lo ? 1 : (Math.sqrt(c) - Math.sqrt(lo)) / (Math.sqrt(hi) - Math.sqrt(lo));
      return Math.round(minF + frac * (maxF - minF));
    };

    await new Promise<void>((resolve) => {
      cloud()
        .size([w, h])
        .words(this.terms.map((t) => ({ text: t.term, size: sizeOf(t.count), count: t.count })))
        .padding(2)
        .rotate(() => (this.options.rotate ? (Math.round(Math.random()) === 1 ? 90 : 0) : 0))
        .font('system-ui, sans-serif')
        .fontWeight('600')
        .fontSize((d: { size?: number }) => d.size ?? minF)
        .on('end', (words: PlacedWord[]) => {
          if (gen === this.generation) {
            this.placed = words;
            this.w = w;
            this.h = h;
          }
          resolve();
        })
        .start();
    });
  }

  override render() {
    if (this.terms.length === 0) return html`<div class="empty">${this.emptyText}</div>`;
    const theme = readChartTheme(this);
    const w = this.w || 300;
    const h = this.h || 200;
    const summary = `Word cloud of ${this.terms.length} ${this.terms.length === 1 ? 'term' : 'terms'}, largest ${this.terms[0]?.term ?? ''}`;
    return html`
      <svg viewBox="0 0 ${w} ${h}" role="img" aria-label=${summary} preserveAspectRatio="xMidYMid meet">
        <g transform="translate(${w / 2},${h / 2})">
          ${this.placed.map(
            (p, i) => html`
              <text text-anchor="middle" transform="translate(${p.x},${p.y}) rotate(${p.rotate})" font-size=${p.size} fill=${theme.palette[i % theme.palette.length] ?? theme.text}>
                <title>${p.text}: ${p.count.toLocaleString()}</title>
                ${p.text}
              </text>
            `,
          )}
        </g>
      </svg>
      ${nothing}
    `;
  }
}

/** The slice of d3-cloud's fluent API this element uses. */
interface CloudLayout {
  size(s: [number, number]): CloudLayout;
  words(w: Array<{ text: string; size: number; count: number }>): CloudLayout;
  padding(n: number): CloudLayout;
  rotate(fn: () => number): CloudLayout;
  font(f: string): CloudLayout;
  fontWeight(f: string): CloudLayout;
  fontSize(fn: (d: { size?: number }) => number): CloudLayout;
  on(ev: 'end', fn: (words: PlacedWord[]) => void): CloudLayout;
  start(): CloudLayout;
}

/** Guarded define — see `chart-element.ts`'s `defineCharts`. */
export function defineWordCloud(): void {
  if (!customElements.get('viz-word-cloud')) customElements.define('viz-word-cloud', VizWordCloud);
}
