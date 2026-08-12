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
      :host {
        display: flex;
        align-items: center;
        gap: 4px;
        width: 100%;
        padding: 0 4px;
        font:
          11px/1.3 system-ui,
          sans-serif;
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
        gap: 3px;
        padding: 1px 6px;
        border: 1px solid rgba(127, 127, 127, 0.35);
        border-radius: 3px;
        background: transparent;
        color: inherit;
        font: inherit;
        cursor: pointer;
      }
      button:hover {
        background: rgba(127, 127, 127, 0.2);
      }
      button .material-icons {
        font-size: 13px;
        line-height: 1;
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
      <button @click=${this.edit} title="Edit this visualization: which columns feed which channel" aria-label="Edit visualization"><span class="material-icons">edit</span>Edit</button>
      <button @click=${() => void this.editTemplate()} title="Edit the chart definition: kind, aggregate and options" aria-label="Edit chart definition">
        <span class="material-icons">tune</span>Chart
      </button>
      <span class="spacer"></span>
      ${this.kindLabel ? html`<span class="kind">${this.kindLabel}</span>` : nothing}
    `;
  }
}
