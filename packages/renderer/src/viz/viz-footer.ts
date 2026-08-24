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
import { focusTableWindow } from '../window-mgr/table-window-manager.js';
import { dockDescriptor } from './viz-dock.js';

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
   * Open the Views dialog straight on this INSTANCE's form — the "Settings"
   * button.
   *
   * `editInstanceId` is the existing entry point the dialog already supports for
   * exactly this — no new dialog surface, and the mapping/options editor it lands
   * on is the same one that created the visualization.
   */
  private settings(): void {
    if (!this.tableId) return;
    openViewsDialog(this.tableId, { editInstanceId: this.viewInstanceId });
  }

  /**
   * Edit the TEMPLATE — the kind, the aggregate, the options every view of this
   * visualization shares.
   *
   * This is what "Edit" means, and "Settings" is the instance. The pair used to
   * read the other way round ("Edit" the instance, "Chart" the definition),
   * which put the shared thing behind the more specific-sounding word: a user
   * looking for "the chart's settings" reached for Chart and got the definition
   * every other view of it also uses.
   */
  private async edit(): Promise<void> {
    if (!this.tableId) return;
    const ctx = await getContext();
    const inst = await ctx.store.viewInstances.findOne(this.viewInstanceId);
    if (!inst) return;
    openViewsDialog(this.tableId, { editTemplateId: inst.templateId });
  }

  /**
   * Pop in: dock this window back above the table it reads — the exact opposite
   * of the pane strip's `open_in_new`, and the way back that button had no
   * counterpart for. Without it, re-docking meant remembering that the Shown-as
   * select in the instance form does it.
   *
   * Docked to the TABLE (`inst.tableId`), which covers a projection too — a
   * projection is a table, so there is no second host to case on.
   *
   * The icon is `south_west` — an arrow from the top right to the bottom left,
   * the mirror of the strip's `open_in_new` (which leaves to the top right). The
   * two are one gesture and its reverse, so they have to look like it.
   *
   * The host window is revealed afterwards because a pane has nowhere to mount
   * while its host is hidden or minimized (see `panel-stacks.ts`): the chart
   * would simply disappear, with the store perfectly correct about why.
   */
  private async dock(): Promise<void> {
    const ctx = await getContext();
    const inst = await ctx.store.viewInstances.findOne(this.viewInstanceId);
    if (!inst) return;
    const instances = await ctx.store.viewInstances.find();
    await ctx.store.viewInstances.patch(inst.id, {
      dock: dockDescriptor({ instances, selfId: inst.id, tableId: inst.tableId, edge: 'above' }),
      // The same flag a pane is shown by. The window closing on its way to
      // becoming a pane must not be read as the user shutting the view.
      open: true,
      updatedAt: Date.now(),
    });
    focusTableWindow(inst.tableId);
  }

  override render() {
    return html`
      <button @click=${() => void this.edit()} title="Edit the definition: kind, aggregate and the options every view of it shares" aria-label="Edit definition">
        <span class="mi sm">code</span>Edit
      </button>
      <button @click=${this.settings} title="Settings for THIS view: its columns, its limit, and any option it overrides" aria-label="Settings for this view">
        <span class="mi sm">tune</span>Settings
      </button>
      <button @click=${() => void this.refresh()} title="Re-read the data and redraw" aria-label="Refresh"><span class="mi sm">refresh</span></button>
      <button @click=${() => void this.exportCsv()} title="Save the numbers behind this chart as a CSV file" aria-label="Export as CSV"><span class="mi sm">download</span>CSV</button>
      <button @click=${() => void this.dock()} title="Dock this chart above its table" aria-label="Dock above the table"><span class="mi sm">south_west</span></button>
      <span class="spacer"></span>
      ${this.kindLabel ? html`<span class="kind">${this.kindLabel}</span>` : nothing}
    `;
  }
}
