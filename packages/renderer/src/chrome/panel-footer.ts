import { LitElement, css, html, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { unsafeSVG } from 'lit/directives/unsafe-svg.js';
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
      /* Icon-only footer buttons: tight, roughly square. A button that has no
         icon (falls back to its text label) still reads fine with this padding. */
      button {
        font: inherit;
        padding: 0.2rem 0.4rem;
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
      /* Inline-SVG icon (e.g. the GitHub mark) sized to match the small material
         glyphs the other footer buttons use. */
      .icon-svg {
        display: inline-flex;
        align-items: center;
      }
      .icon-svg svg {
        width: 1rem;
        height: 1rem;
        display: block;
      }
      /* Danger buttons (e.g. resume an interrupted import) read as red and
         pulse gently to draw the eye. */
      button.danger {
        color: #b91c1c;
        border-color: #fca5a5;
        background: #fef2f2;
        animation: danger-pulse 1.6s ease-in-out infinite;
      }
      button.danger:hover {
        background: #fee2e2;
      }
      @keyframes danger-pulse {
        0%,
        100% {
          border-color: #fca5a5;
        }
        50% {
          border-color: #ef4444;
        }
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

  private runTableButton = async (spec: TableButtonSpec, e?: Event) => {
    // Capture the clicked element NOW — currentTarget is null after the await.
    const anchor = (e?.currentTarget as HTMLElement | undefined) ?? undefined;
    const ctx = await getContext();
    try {
      await Promise.resolve(spec.onClick(ctx.api, { tableId: this.tableId, anchor }));
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[table-button:${spec.id}]`, err);
    }
  };

  override render() {
    return html`
      ${this.table?.readonly
        ? nothing
        : html`<button title="Add a blank row" aria-label="Add row" @click=${this.addRow}>
            <span class="mi sm">add</span>
          </button>`}
      <button title="Edit columns" aria-label="Columns" @click=${this.editColumns}>
        <span class="mi sm">view_column</span>
      </button>
      ${this.tableButtons
        .filter((b) => !b.visible || (this.table != null && b.visible(this.table)))
        .map(
          (b) =>
            // Icon-only: the icon shows, the label moves to title/aria-label so
            // the button stays accessible (and screen-reader / test names hold).
            // Buttons with no icon fall back to their text so they aren't blank.
            html`<button
              class=${b.danger ? 'danger' : ''}
              title=${b.tooltip ?? b.label}
              aria-label=${b.label}
              @click=${(e: Event) => this.runTableButton(b, e)}
            >
              ${b.icon
                ? b.icon.trimStart().startsWith('<svg')
                  ? html`<span class="icon-svg">${unsafeSVG(b.icon)}</span>`
                  : html`<span class="mi sm">${b.icon}</span>`
                : html`<span>${b.label}</span>`}
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
