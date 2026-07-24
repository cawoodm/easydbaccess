import { LitElement, css, html, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { unsafeHTML } from 'lit/directives/unsafe-html.js';
import type { ColumnSpec, Row, ViewInstance, ViewTemplate } from '@easydb/shared';
import { getContext } from '../app-context.js';
import { hasRowHtml, substituteRow, viewRows } from './view-render.js';

/**
 * Read-only render of a single {@link ViewInstance}: a table viewed through a
 * {@link ViewTemplate}. No editing, no add-row, no interactive filters — the
 * instance's snapshotted sort/filter/visible-columns are applied and the data
 * shown as the template dictates. Data stays live: if the underlying table's
 * rows change, the view re-renders.
 *
 * Template HTML is injected verbatim (via `unsafeHTML`) into this component's
 * shadow root, so a template's inline styles / `<style>` scope here without
 * leaking out. Values are the user's own data rendered in the user's own
 * browser (a template author already controls the surrounding markup).
 */
@customElement('view-window')
export class ViewWindow extends LitElement {
  static override styles = css`
    :host {
      display: block;
      overflow: auto;
      height: 100%;
      background: #f8fafc;
      font-family: system-ui, sans-serif;
    }
    .vw-root {
      min-height: 100%;
    }
    .vw-loading,
    .vw-empty {
      padding: 1rem;
      color: #6b7280;
      font-size: 0.9rem;
    }
    /* Fallback read-only table (used when a template has no row HTML). */
    table.vw-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 0.85rem;
    }
    table.vw-table th,
    table.vw-table td {
      border: 1px solid #e5e7eb;
      padding: 0.25rem 0.5rem;
      text-align: left;
      vertical-align: top;
      white-space: nowrap;
    }
    table.vw-table th {
      background: #f9fafb;
      position: sticky;
      top: 0;
    }
    .vw-html {
      padding: 0.5rem 0.75rem;
    }
  `;

  @property({ type: String }) viewInstanceId = '';
  @state() private loaded = false;
  @state() private error = '';
  @state() private instance: ViewInstance | null = null;
  @state() private template: ViewTemplate | null = null;
  @state() private columns: ColumnSpec[] = [];
  @state() private rows: Row[] = [];
  private allRows: Row[] = [];
  private rowsUnsub?: () => void;

  override async connectedCallback() {
    super.connectedCallback();
    await this.load();
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this.rowsUnsub?.();
  }

  override async updated(changed: Map<string, unknown>) {
    if (changed.has('viewInstanceId')) {
      this.rowsUnsub?.();
      this.loaded = false;
      await this.load();
    }
  }

  /** Re-read the instance/template/columns/rows — e.g. after the instance is
   * edited (rename / re-mapping) — without tearing down the window. */
  async reload() {
    this.rowsUnsub?.();
    this.loaded = false;
    await this.load();
  }

  private async load() {
    if (!this.viewInstanceId) return;
    const ctx = await getContext();
    const inst = await ctx.store.viewInstances.findOne(this.viewInstanceId);
    if (!inst) {
      this.error = 'This view no longer exists.';
      this.loaded = true;
      return;
    }
    this.instance = inst;
    this.template = (await ctx.store.viewTemplates.findOne(inst.templateId)) ?? null;
    const table = await ctx.store.tables.findOne(inst.tableId);
    const byField = new Map((table?.columns ?? []).map((c) => [c.field, c]));
    this.columns = inst.visibleColumns.map(
      (f) => byField.get(f) ?? { field: f, label: f, type: 'string' as const },
    );
    const coll = ctx.store.rows(inst.tableId);
    this.rowsUnsub = coll.subscribe((all) => {
      this.allRows = all;
      this.recompute();
    });
    this.allRows = await coll.find();
    this.recompute();
    this.loaded = true;
  }

  private recompute() {
    if (this.instance) this.rows = viewRows(this.allRows, this.instance);
  }

  private renderTable() {
    if (this.rows.length === 0) return html`<div class="vw-empty">No rows.</div>`;
    return html`
      <table class="vw-table">
        <thead>
          <tr>
            ${this.columns.map((c) => html`<th>${c.label || c.field}</th>`)}
          </tr>
        </thead>
        <tbody>
          ${this.rows.map(
            (r) =>
              html`<tr>
                ${this.columns.map((c) => {
                  const v = r.data[c.field];
                  return html`<td>${v == null ? '' : String(v)}</td>`;
                })}
              </tr>`,
          )}
        </tbody>
      </table>
    `;
  }

  override render() {
    if (!this.loaded) return html`<div class="vw-loading">Loading…</div>`;
    if (this.error) return html`<div class="vw-empty">${this.error}</div>`;
    const t = this.template;
    if (!t) return html`<div class="vw-empty">This view's template is missing.</div>`;

    if (hasRowHtml(t.rowHtml)) {
      // Row mode: concatenate header + repeated rows + footer into one HTML
      // block so a header that opens a wrapping tag pairs with the footer.
      const mapping = this.instance?.mapping ?? {};
      const body = this.rows.map((r) => substituteRow(t.rowHtml, r, mapping)).join('');
      const full = (t.headerHtml ?? '') + body + (t.footerHtml ?? '');
      return html`<div class="vw-root">${unsafeHTML(full)}</div>`;
    }

    // Table mode: header/footer HTML above and below a read-only table.
    return html`<div class="vw-root">
      ${t.headerHtml?.trim()
        ? html`<div class="vw-html">${unsafeHTML(t.headerHtml)}</div>`
        : nothing}
      ${this.renderTable()}
      ${t.footerHtml?.trim()
        ? html`<div class="vw-html">${unsafeHTML(t.footerHtml)}</div>`
        : nothing}
    </div>`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'view-window': ViewWindow;
  }
}
