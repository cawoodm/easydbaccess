import { LitElement, css, html } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import type { ColumnSpec, TableButtonSpec } from '@easydb/shared';
import { getContext } from '../app-context.js';

/**
 * Permanent action bar that lives in a jsPanel's footer toolbar. Stays visible
 * regardless of how the data-table inside the content area is scrolled, and
 * never appears at the end of a long table where the user would have to
 * scroll to reach + Add row.
 *
 * Owns: + Add row, Edit columns, plugin TableButtons, and the row count.
 * Earlier these lived inside <data-table>'s action bar at the bottom of the
 * scroll region — they're moved here to match the original minniDBMax layout.
 */
@customElement('panel-footer')
export class PanelFooter extends LitElement {
  static override styles = css`
    :host {
      display: flex;
      align-items: center;
      gap: 0.4rem;
      width: 100%;
      padding: 0.35rem 0.55rem;
      box-sizing: border-box;
      font-size: 0.85rem;
    }
    button {
      font: inherit;
      padding: 0.2rem 0.55rem;
      border: 1px solid #d1d5db;
      background: white;
      border-radius: 0.25rem;
      cursor: pointer;
    }
    button:hover {
      background: #f3f4f6;
    }
    .spacer {
      flex: 1;
    }
    .count {
      color: #6b7280;
    }
  `;

  @property({ type: String }) tableId = '';
  @state() private rowCount = 0;
  @state() private tableButtons: TableButtonSpec[] = [];
  private unsubRows?: () => void;

  override async connectedCallback() {
    super.connectedCallback();
    const ctx = await getContext();
    this.tableButtons = [...ctx.registries.tableButtons];
    ctx.events.on('app:ready', () => (this.tableButtons = [...ctx.registries.tableButtons]));
    const rows = ctx.store.rows(this.tableId);
    this.unsubRows = rows.subscribe((r) => (this.rowCount = r.length));
    this.rowCount = (await rows.find()).length;
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this.unsubRows?.();
  }

  private async addRow() {
    const ctx = await getContext();
    const t = await ctx.store.tables.findOne(this.tableId);
    if (!t) return;
    const blank: Record<string, unknown> = {};
    for (const c of t.columns) blank[c.field] = defaultFor(c);
    await ctx.store.rows(this.tableId).insert({
      id: crypto.randomUUID(),
      tableId: this.tableId,
      data: blank,
      updatedAt: Date.now(),
    });
  }

  private editColumns() {
    document.dispatchEvent(
      new CustomEvent('easydb:edit-columns', {
        detail: { tableId: this.tableId },
      }),
    );
  }

  private async runTableButton(spec: TableButtonSpec) {
    const ctx = await getContext();
    try {
      await Promise.resolve(spec.onClick(ctx.api, { tableId: this.tableId }));
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[table-button:${spec.id}]`, err);
    }
  }

  override render() {
    return html`
      <button @click=${this.addRow}>+ Add row</button>
      <button @click=${this.editColumns}>Edit columns</button>
      ${this.tableButtons.map(
        (b) => html`<button title=${b.tooltip ?? ''} @click=${() => this.runTableButton(b)}>
          ${b.label}
        </button>`,
      )}
      <span class="spacer"></span>
      <span class="count">${this.rowCount} row${this.rowCount === 1 ? '' : 's'}</span>
    `;
  }
}

function defaultFor(c: ColumnSpec): unknown {
  if (c.default !== undefined) return c.default;
  switch (c.type) {
    case 'boolean':
      return false;
    case 'number':
      return null;
    default:
      return '';
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'panel-footer': PanelFooter;
  }
}
