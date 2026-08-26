import { LitElement, css, html, nothing } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import type { ColumnSpec, Row, ViewInstance } from '@easydb/shared';
import { getContext } from '../app-context.js';
import { dialogChromeStyles, ctrlEnterSubmits, makeDialogDraggable } from '@marccawood/lit-dialogs';
import { watchDialogDirty } from '../chrome/dirty-guard.js';
import { offerableRenderers, rendererOptionsFor } from '../table/renderer-options.js';
import { setViewRenderer, toggleViewColumn, viewColumnSpecs, viewRenderer } from '../views/view-columns.js';
import { readRows } from '../db/row-reader.js';
import { readSortSpecs } from '../table/row-sort.js';
import { PREVIEW_ROWS } from '../table/column-preview.js';
import './column-preview-table.js';
import type { PreviewState } from './column-preview-table.js';

/**
 * A view's OWN column editor: which columns it shows, and what draws them.
 *
 * Not the table's columns editor, and deliberately much smaller than it. A view
 * may not change what a column IS — its type, its constraints, its default —
 * because a view is a view OF a table and template-off mode writes THROUGH it to
 * the table's rows. It may change how the column looks, which is the presentation
 * the instance has always owned (`visibleColumns`, `columnWidths`, sort, filters).
 *
 * What this replaces is a bare checkbox popover in the view's footer: visibility
 * and nothing else, with no way to say "show this markdown column as prose here
 * and keep the one-line preview in the grid". Changing the renderer used to mean
 * changing the TABLE's column, which every other view and the grid then followed.
 *
 * Saved per row as it is edited rather than behind an OK button. There is no
 * partial state to validate — a checkbox and a picker are each complete on its
 * own — and the change is on screen before the mouse has moved.
 *
 * It carries the same live preview the table's editor has, over this view's own
 * columns. The view does redraw underneath, but a modal dims it, a template view
 * shows no grid at all, and neither tells you what a renderer you have not picked
 * yet would look like. The preview is the only place where the answer to "what
 * does this column look like as a link?" arrives before the change is made.
 */
export function openViewColumnsDialog(viewInstanceId: string): void {
  const dlg = ViewColumnsDialog.instance ?? mount();
  void dlg.open(viewInstanceId);
}

function mount(): ViewColumnsDialog {
  const el = document.createElement('view-columns-dialog') as ViewColumnsDialog;
  document.body.appendChild(el);
  return el;
}

/** The empty option: follow whatever the table's column says. */
const FROM_TABLE = '';

@customElement('view-columns-dialog')
export class ViewColumnsDialog extends LitElement {
  static instance: ViewColumnsDialog | null = null;

  static override styles = [
    dialogChromeStyles,
    css`
      dialog {
        /* Wider than the column list needs, because the preview under it is
           showing real rows of real data. */
        width: 720px;
        max-width: 94vw;
      }
      p.hint {
        margin: 0;
        color: #6b7280;
        font-size: 0.85rem;
      }
      /* Two panes, and the body is the frame around them rather than the thing
         that scrolls: that is what lets the preview's grip TRADE height with the
         column list instead of just making the dialog longer. */
      .dialog-body {
        overflow: hidden;
        min-height: 0;
      }
      .cols-pane {
        flex: 1 1 auto;
        min-height: 4rem;
        overflow: auto;
        display: flex;
        flex-direction: column;
        gap: 0.6rem;
      }
      table {
        width: 100%;
        border-collapse: collapse;
        font-size: 0.85rem;
      }
      th {
        text-align: left;
        font-weight: 600;
        color: #374151;
        padding: 0.2rem 0.4rem;
        border-bottom: 1px solid #e5e7eb;
      }
      td {
        padding: 0.25rem 0.4rem;
        border-bottom: 1px solid #f3f4f6;
      }
      td.show {
        width: 2.2rem;
        text-align: center;
      }
      td.field {
        color: #6b7280;
      }
      select {
        font: inherit;
        padding: 0.15rem 0.25rem;
        border: 1px solid #d1d5db;
        border-radius: 0.25rem;
        max-width: 12rem;
      }
      tr.hidden td.name,
      tr.hidden td.field {
        opacity: 0.5;
      }
    `,
  ];

  @state() private instance: ViewInstance | null = null;
  @state() private tableColumns: ColumnSpec[] = [];
  @state() private rendererOptions: string[] = [];
  /** First {@link PREVIEW_ROWS} rows the view itself would show. */
  @state() private previewRows: Row[] = [];
  @state() private previewState: PreviewState = 'none';
  @state() private previewError: string | null = null;
  private dialogEl: HTMLDialogElement | null = null;
  private rendererSubUnsub?: (() => void) | undefined;
  /** An answer arriving for a view the dialog has since been reopened on is dropped. */
  private previewToken = 0;

  override connectedCallback(): void {
    super.connectedCallback();
    ViewColumnsDialog.instance = this;
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this.rendererSubUnsub?.();
    if (ViewColumnsDialog.instance === this) ViewColumnsDialog.instance = null;
  }

  override firstUpdated() {
    this.dialogEl = this.shadowRoot?.querySelector('dialog') ?? null;
    const header = this.shadowRoot?.querySelector('.dialog-header') as HTMLElement | null;
    if (this.dialogEl && header) makeDialogDraggable(this.dialogEl, header);
    if (this.dialogEl) watchDialogDirty('view-columns', this.dialogEl);
  }

  async open(viewInstanceId: string): Promise<void> {
    const ctx = await getContext();
    const inst = await ctx.store.viewInstances.findOne(viewInstanceId);
    if (!inst) return;
    this.instance = inst;
    const table = await ctx.store.tables.findOne(inst.tableId);
    this.tableColumns = table?.columns ?? [];
    // Snapshotted like the table editor does it, and kept fresh on `app:ready`:
    // a hot-installed plugin can register a renderer while this is open.
    this.rendererOptions = offerableRenderers(ctx.registries.cellRenderers);
    this.rendererSubUnsub?.();
    this.rendererSubUnsub = ctx.events.on('app:ready', () => {
      this.rendererOptions = offerableRenderers(ctx.registries.cellRenderers);
    });
    // After the dialog is on screen, never before it: the editor is usable
    // without its preview, and a read of a big table is not worth waiting on to
    // tick a checkbox. Same order the table's columns editor settled on.
    void this.loadPreview(inst);
    await this.updateComplete;
    this.dialogEl?.showModal();
  }

  /**
   * The rows the VIEW shows, not the table's first rows.
   *
   * Its filters and its sort go down with the request, because a preview of rows
   * the view excludes is a preview of somebody else's data — and a view is very
   * often a filter over one table. The row cap still applies on top: `limit` here
   * is the smaller of the view's own and what a preview is worth reading.
   */
  private async loadPreview(inst: ViewInstance): Promise<void> {
    const token = ++this.previewToken;
    this.previewRows = [];
    this.previewState = 'loading';
    this.previewError = null;
    try {
      const ctx = await getContext();
      const sort = readSortSpecs(inst);
      const page = await readRows(
        ctx.store.rows(inst.tableId),
        {
          columns: this.tableColumns,
          filters: inst.filters,
          ...(sort.length > 0 ? { sort } : {}),
          limit: inst.limit && inst.limit > 0 ? Math.min(inst.limit, PREVIEW_ROWS) : PREVIEW_ROWS,
        },
        PREVIEW_ROWS,
      );
      if (token !== this.previewToken) return;
      this.previewRows = page.rows;
      this.previewState = 'ready';
    } catch (err) {
      if (token !== this.previewToken) return;
      this.previewRows = [];
      this.previewState = 'error';
      this.previewError = err instanceof Error ? err.message : String(err);
      // eslint-disable-next-line no-console
      console.warn('[view-columns] the preview rows could not be read', err);
    }
  }

  private close() {
    this.dialogEl?.close();
  }

  /**
   * Write one change to the instance, and keep the local copy in step.
   *
   * The dialog reads its own state rather than waiting for the subscription to
   * come back, so a second click lands on the value the first one wrote.
   */
  private async patch(fields: Partial<ViewInstance>): Promise<void> {
    const inst = this.instance;
    if (!inst) return;
    const ctx = await getContext();
    await ctx.store.viewInstances.patch(inst.id, { ...fields, updatedAt: Date.now() });
    this.instance = { ...inst, ...fields };
  }

  private async toggle(field: string): Promise<void> {
    const inst = this.instance;
    if (!inst) return;
    const next = toggleViewColumn(
      inst.visibleColumns,
      this.tableColumns.map((c) => c.field),
      field,
    );
    // Null means this is the last visible column. Refused rather than written, so
    // the view cannot end up a grid with no columns and no way back.
    if (!next) {
      const ctx = await getContext();
      ctx.api.ui.dialogs.toast('A view has to show at least one column.', { kind: 'info' });
      return;
    }
    await this.patch({ visibleColumns: next });
  }

  private async setRenderer(field: string, renderer: string): Promise<void> {
    const inst = this.instance;
    if (!inst) return;
    await this.patch({ columnRenderers: setViewRenderer(inst.columnRenderers, field, renderer) });
  }

  /** Put every column back to the table's renderer. Visibility is left alone. */
  private async resetRenderers(): Promise<void> {
    await this.patch({ columnRenderers: {} });
  }

  private renderRow(col: ColumnSpec, showing: boolean) {
    const inst = this.instance;
    const chosen = inst?.columnRenderers?.[col.field] ?? FROM_TABLE;
    const options = rendererOptionsFor(this.rendererOptions, chosen || undefined);
    // What "from the table" actually means for this column, named in the option
    // rather than left for the user to go and look up.
    const inherited = viewRenderer(col, undefined);
    return html`<tr class=${showing ? '' : 'hidden'}>
      <td class="show">
        <input type="checkbox" .checked=${showing} aria-label=${`Show ${col.label || col.field}`} @change=${() => void this.toggle(col.field)} />
      </td>
      <td class="name">${col.label || col.field}</td>
      <td class="field">${col.field}</td>
      <td>
        <select aria-label=${`Renderer for ${col.label || col.field}`} .value=${chosen} @change=${(e: Event) => void this.setRenderer(col.field, (e.target as HTMLSelectElement).value)}>
          <option value=${FROM_TABLE}>${inherited ? `From the table (${inherited})` : 'From the table'}</option>
          ${options.map((name) => html`<option value=${name} ?selected=${name === chosen}>${name}</option>`)}
        </select>
      </td>
    </tr>`;
  }

  override render() {
    const inst = this.instance;
    const showing = new Set(inst?.visibleColumns ?? []);
    const overrides = Object.keys(inst?.columnRenderers ?? {}).length;
    return html`
      <dialog @cancel=${this.close} @keydown=${ctrlEnterSubmits}>
        <button type="button" class="close-x" title="Close" @click=${this.close}>×</button>
        <div class="dialog-header">
          <h2>Columns${inst ? html` — ${inst.name}` : nothing}</h2>
          <div class="header-actions">
            ${overrides > 0 ? html`<button type="button" class="ghost" @click=${() => void this.resetRenderers()}>Use the table's renderers</button>` : nothing}
            <button type="button" class="primary" @click=${this.close}>Done</button>
          </div>
        </div>
        <div class="dialog-body">
          <div class="cols-pane">
            <p class="hint">This view only. The table keeps its own columns, and so does every other view of it.</p>
            ${this.tableColumns.length === 0
              ? html`<p class="hint">This view's table has no columns.</p>`
              : html`<table>
                  <thead>
                    <tr>
                      <th class="show">Show</th>
                      <th>Column</th>
                      <th>Field</th>
                      <th>Renderer</th>
                    </tr>
                  </thead>
                  <tbody>
                    ${this.tableColumns.map((c) => this.renderRow(c, showing.has(c.field)))}
                  </tbody>
                </table>`}
          </div>
          ${inst
            ? html`<column-preview-table
                .columns=${viewColumnSpecs(this.tableColumns, inst.visibleColumns, { renderers: inst.columnRenderers })}
                .rows=${this.previewRows}
                .state=${this.previewState}
                .error=${this.previewError}
              ></column-preview-table>`
            : nothing}
        </div>
      </dialog>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'view-columns-dialog': ViewColumnsDialog;
  }
}
