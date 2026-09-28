// packages/renderer/src/viz/viz-record.ts
//
// `<viz-record>` — ONE row of the pane's data, drawn through the user's own HTML
// (or a generated card when there is none).
//
// **It is `viz-custom-html`'s sibling, and the difference is singular vs plural.**
// That element's tokens describe the whole set — `$COUNT`, `$SUM.amount`. These
// describe one record — `$title`, `$input.body`, `$raw.created` — which means the
// token vocabulary is the VIEW TEMPLATE one (`views/view-render.ts`), not the
// aggregate one (`viz/viz-tokens.ts`). Handed an identity mapping, `substituteRow`
// makes a token its own field name and nothing in that module changed.
//
// So a record pane gets three things a custom-HTML pane does not, all of them
// already written for the view window:
//
//  - **cell renderers.** A plain `$body` leaves a slot that this element mounts
//    the column's real renderer into, so a markdown column reads as prose here
//    exactly as it does in a view. Properties cannot go in an HTML string, hence
//    the second pass.
//  - **`$input.FIELD` controls**, which make the pane a form.
//  - **which row**. A pane is handed `rows`, plural; `currentRowId` picks one.
//
// **It reaches no store.** Like every other drawing element it draws what it was
// given, and an edit leaves as a `viz-record-edit-request` event for `viz-panel`
// to validate and write — the same shape as `viz-filter-request`. That keeps the
// rule the pane elements share: a picture asks, the panel acts.

import { LitElement, css, html } from 'lit';
import type { PropertyValues } from 'lit';
import type { ColumnSpec, Row } from '@easydb/shared';
import { CELL_SLOT_CLASS, substituteRow, tokenValue } from '../views/view-render.js';
import { generatedCardHtml, identityMapping, isEmptyLayout } from '../views/record-html.js';
import { withRowMeta } from '../views/row-meta.js';
import { inputTargetOf, readInputValue } from '../views/input-writeback.js';
import { sameRowRefs, sameVizOptions } from './elements/same-input.js';

/** What the pane asks its host to write. Handled by `viz-panel`. */
export interface VizRecordEditRequest {
  rowId: string;
  field: string;
  value: unknown;
}

export interface RecordVizOptions {
  /** The user's layout. Empty ⇒ the generated card. */
  html?: string | undefined;
  /** Renderer names → tags, so a `$FIELD` can mount the column's real renderer. */
  renderers?: Map<string, string> | undefined;
}

export class VizRecord extends LitElement {
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
    /* The generated card. Styled here rather than in the markup it produces, so
       a user who takes that markup as a starting point inherits the look and can
       drop the classes without losing it entirely. */
    .canvas .eda-rec-card {
      display: grid;
      gap: 0.15rem 0.75rem;
    }
    .canvas .eda-rec-row {
      display: grid;
      grid-template-columns: minmax(6rem, 12rem) 1fr;
      gap: 0.75rem;
      padding: 0.2rem 0;
      border-bottom: 1px solid var(--viz-grid-line, rgba(127, 127, 127, 0.18));
    }
    .canvas .eda-rec-row:last-child {
      border-bottom: 0;
    }
    .canvas .eda-rec-label {
      color: var(--viz-muted-text, rgba(127, 127, 127, 0.9));
      overflow-wrap: anywhere;
    }
    .canvas .eda-rec-value {
      overflow-wrap: anywhere;
    }
    /* Same controls a view template's $input.TOKEN produces — one look for one
       thing, wherever it is met. */
    .canvas .eda-input {
      font: inherit;
      width: 100%;
      box-sizing: border-box;
      padding: 0.1rem 0.3rem;
      border: 1px solid var(--viz-grid-line, rgba(127, 127, 127, 0.3));
      border-radius: 0.2rem;
      background: transparent;
      color: inherit;
    }
    .canvas input[type='checkbox'].eda-input {
      width: auto;
    }
    .canvas .eda-input:disabled {
      opacity: 0.6;
      cursor: not-allowed;
    }
    /* Same pill as a view template's and a custom pane's $filter.FIELD. */
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
  `;

  rows: Row[] = [];
  columns: ColumnSpec[] = [];
  options: RecordVizOptions = {};
  /** Which row to draw. Absent ⇒ the first of `rows` — see {@link record}. */
  currentRowId: string | null = null;
  /** The pane, its view or its table is read-only: every control is disabled. */
  readonly = false;

  static override get properties() {
    return {
      rows: { attribute: false },
      columns: { attribute: false },
      options: { attribute: false },
      currentRowId: { attribute: false },
      readonly: { attribute: false },
    };
  }

  /**
   * The row on screen.
   *
   * A selection that is no longer in `rows` falls back to the first one rather
   * than drawing nothing. That is the same reading of "no selection" the pane
   * starts with, and it is what a filter that excludes the selected record
   * should do — the record went off screen, so the pane follows the grid rather
   * than showing a row the grid is not.
   */
  private record(): Row | undefined {
    if (this.currentRowId) {
      const hit = this.rows.find((r) => r.id === this.currentRowId);
      if (hit) return hit;
    }
    return this.rows[0];
  }

  override render() {
    if (this.rows.length === 0) {
      return html`<div class="empty">No record to show. The grid this pane is docked to has no rows.</div>`;
    }
    if (this.columns.length === 0) {
      return html`<div class="empty">This table has no columns yet.</div>`;
    }
    // Lit renders the shell only; `draw()` fills the container in `updated()`,
    // because the markup is a string and the renderer slots in it need a second,
    // imperative pass. Same arrangement as `viz-custom-html`.
    return html`<div class="canvas" @change=${this.onChange}></div>`;
  }

  override updated(changed: PropertyValues): void {
    if (!this.drawnFor(changed)) return;
    this.draw();
  }

  /** The input the markup on screen was drawn from — see `elements/same-input.ts`. */
  private drawnRows: readonly Row[] = [];
  private drawnColumns: readonly ColumnSpec[] = [];
  private drawnOptions: RecordVizOptions = {};
  private drawnId: string | null = null;

  /**
   * Has anything the drawing depends on actually changed?
   *
   * The same guard `viz-custom-html` needs and for the same reason: `viz-panel`
   * hands over a fresh `rows` array on every render, so without this a column
   * resized in the grid beside the pane redraws it per pointermove — and a
   * redraw here throws away whatever the user was typing into an `$input`.
   */
  private drawnFor(changed: PropertyValues): boolean {
    if (this.drawnId !== (this.record()?.id ?? null)) return true;
    if (changed.has('readonly')) return true;
    return !(sameRowRefs(this.drawnRows, this.rows) && sameRowRefs(this.drawnColumns, this.columns) && sameVizOptions(this.drawnOptions, this.options));
  }

  /**
   * Redraw from the row we already have, even though nothing it draws from has
   * changed.
   *
   * The one caller is a REFUSED edit. `drawnFor` exists to stop a redraw
   * throwing away what the user is typing, so after a refusal it is exactly
   * wrong: the control still shows the value that was rejected, and a plain
   * `requestUpdate()` would be a no-op. Clearing `drawnId` is what puts the
   * stored value back in the box.
   */
  redraw(): void {
    this.drawnId = null;
    this.requestUpdate();
  }

  private draw(): void {
    const el = this.renderRoot.querySelector<HTMLElement>('.canvas');
    if (!el) return;
    const row = this.record();
    if (!row) return;
    this.drawnRows = this.rows;
    this.drawnColumns = this.columns;
    this.drawnOptions = this.options;
    this.drawnId = row.id;

    // Editable unless the record cannot be written at all. "Editable from the
    // start" is the feature's own rule: a card you have to convert into a form
    // before you can correct a typo in it is a card you read once. Where the
    // table or the pane IS read-only, generate the plain tokens instead — the
    // column's real renderer then draws each value, which reads far better than
    // a column of disabled input boxes.
    const layout = isEmptyLayout(this.options.html) ? generatedCardHtml(this.columns, { editable: !this.readonly }) : (this.options.html as string);
    el.innerHTML = substituteRow(layout, row, identityMapping(this.columns), {
      columns: new Map(this.columns.map((c) => [c.field, c])),
      readonly: this.readonly,
      renderers: this.options.renderers,
    });
    this.mountCellRenderers(el, row);
  }

  /**
   * Put the real cell-renderer element inside each slot `substituteRow` left.
   *
   * The view window does exactly this (`mountCellRenderers`) and for exactly the
   * same reason: a renderer is a custom element driven by PROPERTIES, and a
   * property cannot be written into an HTML string.
   *
   * `expanded` is on, as it is in a view: a renderer that flattens its value to
   * one line for the grid (`preview`, `markdown`) should render properly in a
   * record, where there is room.
   */
  private mountCellRenderers(root: HTMLElement, row: Row): void {
    const slots = root.querySelectorAll(`.${CELL_SLOT_CLASS}:not([data-eda-mounted])`);
    if (slots.length === 0) return;
    const specs = new Map(this.columns.map((c) => [c.field, c]));
    for (const slot of slots) {
      const el = slot as HTMLElement;
      el.dataset.edaMounted = '1';
      const field = el.dataset.edaField ?? '';
      const tag = el.dataset.edaTag ?? '';
      const spec = specs.get(field);
      if (!spec || !tag) continue;
      const cell = document.createElement(tag) as HTMLElement & {
        value?: unknown;
        column?: ColumnSpec;
        row?: Record<string, unknown>;
        readonly?: boolean;
        sourceReadonly?: boolean;
        expanded?: boolean;
      };
      cell.value = tokenValue(row, field, undefined) ?? '';
      cell.column = spec;
      cell.row = withRowMeta(row);
      cell.readonly = true;
      cell.sourceReadonly = true;
      cell.expanded = true;
      el.replaceChildren(cell);
    }
  }

  /**
   * An `$input.FIELD` control changed. Ask the panel to write it.
   *
   * Nothing is validated here and nothing is written here — the element has no
   * store and no table id. It reads the control and leaves, which is the same
   * contract `viz-filter-request` keeps for a pill.
   */
  private onChange = (e: Event): void => {
    const target = inputTargetOf(e.target);
    if (!target || this.readonly) return;
    const value = readInputValue(e.target as HTMLInputElement, target.type);
    this.dispatchEvent(
      new CustomEvent<VizRecordEditRequest>('viz-record-edit-request', {
        detail: { rowId: target.rowId, field: target.field, value },
        bubbles: true,
        composed: true,
      }),
    );
  };
}

/** Guarded define — see `elements/chart-element.ts`'s `defineCharts`. */
export function defineVizRecord(): void {
  if (!customElements.get('viz-record')) customElements.define('viz-record', VizRecord);
}
