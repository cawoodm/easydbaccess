import { LitElement, css, html, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { unsafeSVG } from 'lit/directives/unsafe-svg.js';
import type { Table, TableButtonSpec } from '@easydb/shared';
import { getContext } from '../app-context.js';
import { VISIBLE_COUNT_EVENT, visibleCountOf, type VisibleCountDetail } from '../window-mgr/panel-title.js';
import { materialIconStyles } from './material-icon-css.js';
import { blankRecord, recordFields } from '../table/new-record.js';
import { openNewRecordDialog } from '../dialogs/new-record-dialog.js';

/**
 * Permanent action bar that lives in a panel window's footer toolbar. Stays visible
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
   * When false the footer shows no row count. The window manager sets it false for
   * a minimized window, which has no grid to take a count from anyway.
   */
  @property({ type: Boolean }) active = true;
  @state() private rowCount = 0;
  @state() private tableButtons: TableButtonSpec[] = [];
  @state() private table: Table | null = null;
  /**
   * Row-source types whose provider declared `schemaEditable: false` — their
   * schema is owned elsewhere, so the column editor is hidden. Snapshotted from
   * the registry rather than hard-coding provider names here, so core chrome
   * stays ignorant of which plugins exist.
   */
  @state() private fixedSchemaSources: Set<string> = new Set();
  private unsubTables?: () => void;
  // Guard so an `active` toggle + connectedCallback can't double-listen.
  private rowsActive = false;

  override async connectedCallback() {
    super.connectedCallback();
    const ctx = await getContext();
    this.tableButtons = [...ctx.registries.tableButtons];
    this.fixedSchemaSources = collectFixedSchemaSources(ctx.registries.rowSources);
    ctx.events.on('app:ready', () => {
      this.tableButtons = [...ctx.registries.tableButtons];
      this.fixedSchemaSources = collectFixedSchemaSources(ctx.registries.rowSources);
    });
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

  /**
   * Take the row count from the grid instead of reading the rows.
   *
   * The footer wants one NUMBER, and it used to `subscribe`, which materializes
   * every row so it has an array to pass and then keeps only `.length`. On a
   * 609,283-row table that was a full read on open and another on every write —
   * a second copy of the read the grid had just been taught to avoid.
   *
   * The grid already publishes the same figure for the panel titlebar
   * (`easydb:visible-count`), computed from a count it has anyway, so the footer
   * listens for it. Nothing here reads the store at all now.
   */
  private startRows() {
    if (this.rowsActive) return;
    this.rowsActive = true;
    // The event only fires on a change, so a footer that mounts after its grid
    // settled needs the remembered value.
    const known = visibleCountOf(this.tableId);
    if (known) this.rowCount = known.total;
    document.addEventListener(VISIBLE_COUNT_EVENT, this.onVisibleCount as EventListener);
  }

  private onVisibleCount = (e: Event) => {
    const d = (e as CustomEvent<VisibleCountDetail>).detail;
    if (d?.key !== this.tableId) return;
    this.rowCount = d.total;
  };

  private stopRows() {
    this.rowsActive = false;
    document.removeEventListener(VISIBLE_COUNT_EVENT, this.onVisibleCount as EventListener);
  }

  /**
   * Ask for the record, rather than inserting a blank row and leaving the user to
   * find it.
   *
   * A blank row lands wherever the current sort puts it, which on a big table is
   * "somewhere in 600,000 rows". The form fills the fields in one place, with the
   * columns' own defaults already in the boxes — see `new-record-dialog.ts`.
   *
   * A table with nothing to fill in keeps the old behaviour: no columns means no
   * form, and a dialog with one sentence and a Save button is a worse way to add
   * an empty row than the button that was already pressed.
   */
  private async addRow() {
    const ctx = await getContext();
    const t = await ctx.store.tables.findOne(this.tableId);
    if (!t) return;
    if (recordFields(t.columns, true).length > 0) {
      await openNewRecordDialog(this.tableId);
      return;
    }
    await ctx.store.rows(this.tableId).insert({
      id: crypto.randomUUID(),
      tableId: this.tableId,
      data: blankRecord(t.columns),
      updatedAt: Date.now(),
    });
  }

  private editColumns() {
    // Every table — projections included — edits its columns here. A projection
    // inherits its column settings from its sources once and then owns them, so
    // the ordinary editor is the right tool; its join is edited from the
    // separate "Edit Join" button the projection plugin registers.
    document.dispatchEvent(new CustomEvent('easydb:edit-columns', { detail: { tableId: this.tableId } }));
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

  /**
   * Whether this table's columns can be edited here. A `readonly` LOCAL table
   * still can — that flag is toggled inside the column editor itself (v0.0.216),
   * so hiding on `readonly` would lock the user out of undoing it. Only a row
   * source that declared `schemaEditable: false` (its schema lives in a file or
   * a remote we do not own) removes the button.
   */
  private get schemaEditable(): boolean {
    const type = this.table?.source?.type;
    return !type || !this.fixedSchemaSources.has(type);
  }

  override render() {
    return html`
      ${this.table?.readonly
        ? nothing
        : html`<button title="Add a record" aria-label="Add row" @click=${this.addRow}>
            <span class="mi sm">add</span>
          </button>`}
      ${this.schemaEditable
        ? html`<button title="Edit columns" aria-label="Columns" @click=${this.editColumns}>
            <span class="mi sm">view_column</span>
          </button>`
        : nothing}
      ${this.tableButtons
        .filter((b) => !b.visible || (this.table != null && b.visible(this.table)))
        .map(
          (b) =>
            // Icon-only: the icon shows, the label moves to title/aria-label so
            // the button stays accessible (and screen-reader / test names hold).
            // Buttons with no icon fall back to their text so they aren't blank.
            html`<button class=${b.danger ? 'danger' : ''} title=${b.tooltip ?? b.label} aria-label=${b.label} @click=${(e: Event) => this.runTableButton(b, e)}>
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


declare global {
  interface HTMLElementTagNameMap {
    'panel-footer': PanelFooter;
  }
}

/**
 * The row-source types whose provider opted out of schema editing. Pulled from
 * the registry so this core chrome never names a plugin.
 */
function collectFixedSchemaSources(rowSources: Map<string, { schemaEditable?: boolean | undefined }>): Set<string> {
  const out = new Set<string>();
  for (const [type, provider] of rowSources) {
    if (provider.schemaEditable === false) out.add(type);
  }
  return out;
}
