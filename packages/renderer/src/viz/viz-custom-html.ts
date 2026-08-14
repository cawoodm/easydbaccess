// packages/renderer/src/viz/viz-custom-html.ts
//
// `<viz-custom-html>` — the user's own HTML (and optionally their own JS) as a
// visualization of whatever the pane was given.
//
// **Why it is here and not in `viz/elements/`.** That folder holds portable
// DRAWING primitives: a chart, a map, a cloud, each importing nothing from the
// app so it could be lifted out tomorrow. This is not one of those. It runs the
// user's script against this app's conventions — its token vocabulary, its pill
// contract, its script helpers — so it belongs beside `viz-panel.ts`, which is
// app-side by design.
//
// **The HTML comes first, the script second.** Tokens are substituted into the
// markup and it is written into the container; only then does the script run,
// with that markup already in place. So the common case is a block of HTML with
// `$COUNT` and some `$filter.` pills and NO script, and the script is there for
// the case that genuinely needs one.
//
// **Filtering is a request, not an action.** A pill click and `api.filter()` both
// leave here as a `viz-filter-request` event. Which grid narrows — the host
// beside the pane, the view instance behind it, or nothing because the
// visualization is in its own window — is a question about docking that only
// `viz-panel` can answer. See `table/pane-actions.ts` for the seam it answers it
// through.
//
// The container is filled imperatively rather than through `unsafeHTML`, because
// the script may write into it: Lit owns the shell, and everything inside
// `.canvas` belongs to the user for the life of the render.

import { LitElement, css, html } from 'lit';
import type { PropertyValues } from 'lit';
import type { ColumnSpec, Row } from '@easydb/shared';
import { runVizScript } from '../util/column-script.js';
import { substituteVizTokens } from './viz-tokens.js';

/** What the pane asks its host to do. Handled by `viz-panel`. */
export interface VizFilterRequest {
  field: string;
  value: string;
}

/** What the pane asks its host to sort by. Handled by `viz-panel`. */
export interface VizSortRequest {
  field: string;
  additive: boolean;
}

export interface CustomHtmlOptions {
  html?: string | undefined;
  script?: string | undefined;
}

/**
 * The `api` a visualization script receives. Deliberately small: everything on
 * it is either the data it draws or a way of asking the host to change, and
 * nothing on it reaches the store — a pane draws what the grid gave it.
 */
export interface VizScriptApi {
  /** The element's own container. Write into it, or return a string instead. */
  el: HTMLElement;
  /** The table's column specs, so a script can label and format. */
  columns: readonly ColumnSpec[];
  /** Narrow the host grid on one column — the same request a pill makes. */
  filter(field: string, value: string): void;
  /** Sort the host grid by one column; `additive` adds a level. */
  sort(field: string, additive?: boolean): void;
}

export class VizCustomHtml extends LitElement {
  static override styles = css`
    :host {
      display: block;
      height: 100%;
      overflow: auto;
      font: 13px/1.5 var(--viz-font-family, system-ui, sans-serif);
      color: var(--viz-text, inherit);
    }
    .canvas {
      padding: 0.5rem 0.75rem;
    }
    .empty,
    .error {
      display: flex;
      align-items: center;
      justify-content: center;
      height: 100%;
      padding: 0.5rem 1rem;
      text-align: center;
      font: 12px/1.5 var(--viz-font-family, system-ui, sans-serif);
      color: var(--viz-muted-text, rgba(127, 127, 127, 0.9));
    }
    /* A script that will not compile, or that throws. Shown in place of the
       picture, the way a broken column script is marked in its cell — a blank
       pane would read as "no data" and hide the fault. */
    .error {
      color: #b91c1c;
      background: #fee2e2;
      white-space: pre-wrap;
    }
    /* Same pill as a view template's $filter.TOKEN (see views/view-window.ts)
       — one look for one thing, wherever it is met. */
    .canvas .eda-filter-pill {
      font: inherit;
      display: inline;
      padding: 0.05rem 0.5rem;
      margin: 0 0.1rem;
      border: none;
      border-radius: 1rem;
      background: #e0f2fe;
      color: #0369a1;
      cursor: pointer;
    }
    .canvas .eda-filter-pill:hover {
      background: #bae6fd;
    }
    .canvas .eda-pill-more {
      margin: 0 0.25rem;
      color: var(--viz-muted-text, rgba(127, 127, 127, 0.9));
    }
    .canvas .eda-token-error {
      display: inline-block;
      padding: 0 0.35rem;
      border-radius: 0.25rem;
      background: #fee2e2;
      color: #b91c1c;
    }
  `;

  rows: Row[] = [];
  columns: ColumnSpec[] = [];
  options: CustomHtmlOptions = {};

  /** Set when the last draw's script failed; shown instead of the picture. */
  private scriptError: string | null = null;

  static override get properties() {
    return {
      rows: { attribute: false },
      columns: { attribute: false },
      options: { attribute: false },
      scriptError: { state: true },
    };
  }

  override render() {
    if (this.scriptError) return html`<div class="error" role="status">${this.scriptError}</div>`;
    const src = this.options.html ?? '';
    const hasScript = (this.options.script ?? '').trim() !== '';
    if (src.trim() === '' && !hasScript) {
      return html`<div class="empty">Nothing to draw yet. Add some HTML with Edit — the samples show what a custom visualization can be.</div>`;
    }
    // Lit renders the shell only; `draw()` fills the container in `updated()`.
    return html`<div class="canvas" @click=${this.onCanvasClick}></div>`;
  }

  override updated(changed: PropertyValues): void {
    // A `scriptError` change is the render that REPLACED the canvas, so there is
    // nothing to draw into and re-running would loop.
    if (changed.size === 1 && changed.has('scriptError')) return;
    this.draw();
  }

  /**
   * Substitute the tokens, write the markup, then run the script over it.
   *
   * The error is captured into state rather than thrown: a broken custom
   * visualization is a broken picture, not a broken window, and the message is
   * the only way its author finds out what is wrong.
   */
  private draw(): void {
    const el = this.renderRoot.querySelector<HTMLElement>('.canvas');
    if (!el) return;
    el.innerHTML = substituteVizTokens(this.options.html ?? '', this.rows, this.columns);
    const run = runVizScript(this.options.script, this.rows, this.scriptApi(el));
    if (!run.ok) {
      this.scriptError = `Script ${run.label}: ${run.message}`;
      return;
    }
    if (typeof run.value === 'string') el.innerHTML = run.value;
    if (this.scriptError !== null) this.scriptError = null;
  }

  private scriptApi(el: HTMLElement): VizScriptApi {
    return {
      el,
      columns: this.columns,
      filter: (field, value) => this.requestFilter(field, String(value)),
      sort: (field, additive) => this.requestSort(field, additive === true),
    };
  }

  /** A `$filter.FIELD` pill in the user's markup was clicked. */
  private onCanvasClick = (e: Event): void => {
    const t = e.target;
    if (!(t instanceof HTMLElement)) return;
    const pill = t.closest('.eda-filter-pill');
    if (!pill) return;
    const field = pill.getAttribute('data-eda-filter-field');
    const value = pill.getAttribute('data-eda-filter-value');
    if (!field || value == null) return;
    this.requestFilter(field, value);
  };

  private requestFilter(field: string, value: string): void {
    if (!field) return;
    this.dispatchEvent(new CustomEvent<VizFilterRequest>('viz-filter-request', { detail: { field, value }, bubbles: true, composed: true }));
  }

  private requestSort(field: string, additive: boolean): void {
    if (!field) return;
    this.dispatchEvent(new CustomEvent<VizSortRequest>('viz-sort-request', { detail: { field, additive }, bubbles: true, composed: true }));
  }
}

/** Guarded define — see `elements/chart-element.ts`'s `defineCharts`. */
export function defineCustomHtml(): void {
  if (!customElements.get('viz-custom-html')) customElements.define('viz-custom-html', VizCustomHtml);
}
