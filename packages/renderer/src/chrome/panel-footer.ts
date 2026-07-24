import { LitElement, css, html } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import type { ColumnSpec, Table, TableButtonSpec } from '@easydb/shared';
import { getContext } from '../app-context.js';
import { materialIconStyles } from './material-icon-css.js';

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
  static override styles = [
    materialIconStyles,
    css`
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
        display: inline-flex;
        align-items: center;
        gap: 0.3rem;
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
      .mi.sm {
        font-size: 0.95rem;
      }
    `,
  ];

  @property({ type: String }) tableId = '';
  /**
   * When false the footer does NOT subscribe to rows (its count would trigger a
   * fetch for a live/remote table). The window manager sets it false for a
   * minimized window so a minimized table loads nothing until it's expanded.
   */
  @property({ type: Boolean }) active = true;
  @state() private rowCount = 0;
  @state() private tableButtons: TableButtonSpec[] = [];
  @state() private table: Table | null = null;
  private unsubRows?: (() => void) | undefined;
  private unsubTables?: () => void;
  // Synchronous guard so an `active` toggle + connectedCallback can't
  // double-subscribe across their awaits.
  private rowsActive = false;

  override async connectedCallback() {
    super.connectedCallback();
    const ctx = await getContext();
    this.tableButtons = [...ctx.registries.tableButtons];
    ctx.events.on('app:ready', () => (this.tableButtons = [...ctx.registries.tableButtons]));
    // Track this table's record (cheap; no row fetch) so per-table button
    // visibility (e.g. a backend Refresh button) reacts to source changes.
    this.table = (await ctx.store.tables.findOne(this.tableId)) ?? null;
    this.unsubTables = ctx.store.tables.subscribe((all) => {
      this.table = all.find((t) => t.id === this.tableId) ?? null;
    });
    if (this.active) void this.startRows();
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this.stopRows();
    this.unsubTables?.();
  }

  override updated(changed: Map<string, unknown>) {
    if (changed.has('active')) {
      if (this.active) void this.startRows();
      else this.stopRows();
    }
  }

  private async startRows() {
    if (this.rowsActive) return;
    this.rowsActive = true;
    const ctx = await getContext();
    if (!this.rowsActive) return; // stopped during the await
    this.unsubRows = ctx.store.rows(this.tableId).subscribe((r) => (this.rowCount = r.length));
  }

  private stopRows() {
    this.rowsActive = false;
    this.unsubRows?.();
    this.unsubRows = undefined;
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
      <button title="Add a blank row" @click=${this.addRow}>
        <span class="mi sm">add</span><span>Add row</span>
      </button>
      <button title="Edit columns" @click=${this.editColumns}>
        <span class="mi sm">view_column</span><span>Columns</span>
      </button>
      ${this.tableButtons
        .filter((b) => !b.visible || (this.table != null && b.visible(this.table)))
        .map(
          (b) =>
            html`<button title=${b.tooltip ?? b.label} @click=${() => this.runTableButton(b)}>
              ${b.icon ? html`<span class="mi sm">${b.icon}</span>` : ''}
              <span>${b.label}</span>
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
