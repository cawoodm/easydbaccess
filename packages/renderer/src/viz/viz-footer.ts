// packages/renderer/src/viz/viz-footer.ts
//
// `<viz-footer>` — the toolbar along the bottom of a visualization window.
//
// A table window has `panel-footer` (add row, columns, exporters…) and an HTML
// view window has nothing, which was fine while a view was only ever a rendering
// of a table it could not change. A visualization is different: what it SHOWS is
// a configuration — which kind, which columns on which channels, which aggregate
// — and until now the only way back to that was to remember it lives behind the
// table's Views button. So the window carries its own way in.
//
// `panel-footer` is not reused: it is per-TABLE and its buttons (add row, edit
// columns, export CSV) are all about the rows, none of which a visualization owns.
// This is a different toolbar for a different thing, kept deliberately small.

import { LitElement, css, html, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { getContext } from '../app-context.js';
import { materialIconStyles } from '../chrome/material-icon-css.js';
import { openViewsDialog } from '../dialogs/views-dialog.js';

@customElement('viz-footer')
export class VizFooter extends LitElement {
  static override styles = [
    materialIconStyles,
    css`
      /* Proportions copied from chrome/panel-footer.ts so a visualization
         window's footer reads as the same piece of furniture as a table
         window's. It was 11px type with no padding before, which measured 18px
         tall and did not read as a footer at all. */
      :host {
        display: flex;
        align-items: center;
        gap: 0.4rem;
        width: 100%;
        padding: 0.35rem 0.55rem;
        box-sizing: border-box;
        font-size: 0.85rem;
      }
      .spacer {
        flex: 1;
      }
      .kind {
        opacity: 0.6;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      button {
        display: inline-flex;
        align-items: center;
        gap: 0.25rem;
        font: inherit;
        padding: 0.2rem 0.4rem;
        border: 1px solid #d1d5db;
        border-radius: 0.25rem;
        background: white;
        color: inherit;
        cursor: pointer;
      }
      button:hover {
        background: #f3f4f6;
      }
    `,
  ];

  @property({ type: String }) viewInstanceId = '';

  @state() private tableId = '';
  @state() private kindLabel = '';

  override connectedCallback(): void {
    super.connectedCallback();
    void this.load();
  }

  /**
   * Resolve the bound table (the dialog is opened per-table) and the kind's
   * display name, so the footer can say what it is showing.
   */
  private async load(): Promise<void> {
    if (!this.viewInstanceId) return;
    const ctx = await getContext();
    const inst = await ctx.store.viewInstances.findOne(this.viewInstanceId);
    if (!inst) return;
    this.tableId = inst.tableId;
    const tpl = await ctx.store.viewTemplates.findOne(inst.templateId);
    const kind = tpl?.viz?.kind;
    this.kindLabel = (kind ? ctx.registries.visualizations.get(kind)?.label : '') ?? '';
  }

  /** Ask the panel to re-read its data. */
  private async refresh(): Promise<void> {
    const panel = this.closest('.jsPanel')?.querySelector('viz-panel') as (HTMLElement & { refreshNow?: () => Promise<void> }) | null;
    await panel?.refreshNow?.();
  }

  /**
   * Save the drawn numbers as CSV.
   *
   * The panel owns the data, so the footer asks it: they are siblings in the
   * panel shell (content vs. footer), found by walking up to the window rather
   * than by threading a reference through the window manager.
   *
   * Goes through `api.backend.saveFile` like every other exporter, so it picks up
   * the native save dialog when that lands in Electron.
   */
  private async exportCsv(): Promise<void> {
    const panel = this.closest('.jsPanel')?.querySelector('viz-panel') as (HTMLElement & { exportCsv?: () => { filename: string; text: string } | null }) | null;
    const out = panel?.exportCsv?.();
    const ctx = await getContext();
    if (!out) {
      ctx.api.ui.dialogs.toast('There is nothing drawn to export yet.', { kind: 'info' });
      return;
    }
    await ctx.api.backend.saveFile(out.filename, out.text, 'text/csv');
  }

  /**
   * Open the Views dialog straight on this instance's edit form.
   *
   * `editInstanceId` is the existing entry point the dialog already supports for
   * exactly this — no new dialog surface, and the mapping/options editor it lands
   * on is the same one that created the visualization.
   */
  private edit(): void {
    if (!this.tableId) return;
    openViewsDialog(this.tableId, { editInstanceId: this.viewInstanceId });
  }

  /** Edit the TEMPLATE — the kind, the aggregate, the options shared by every instance. */
  private async editTemplate(): Promise<void> {
    if (!this.tableId) return;
    const ctx = await getContext();
    const inst = await ctx.store.viewInstances.findOne(this.viewInstanceId);
    if (!inst) return;
    openViewsDialog(this.tableId, { editTemplateId: inst.templateId });
  }

  override render() {
    return html`
      <button @click=${this.edit} title="Edit this visualization: which columns feed which channel" aria-label="Edit visualization"><span class="mi sm">edit</span>Edit</button>
      <button @click=${() => void this.editTemplate()} title="Edit the chart definition: kind, aggregate and options" aria-label="Edit chart definition"><span class="mi sm">tune</span>Chart</button>
      <button @click=${() => void this.refresh()} title="Re-read the data and redraw" aria-label="Refresh"><span class="mi sm">refresh</span></button>
      <button @click=${() => void this.exportCsv()} title="Save the numbers behind this chart as a CSV file" aria-label="Export as CSV"><span class="mi sm">download</span>CSV</button>
      <span class="spacer"></span>
      ${this.kindLabel ? html`<span class="kind">${this.kindLabel}</span>` : nothing}
    `;
  }
}
