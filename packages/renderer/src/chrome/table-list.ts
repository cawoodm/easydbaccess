import { LitElement, css, html } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import type { Table } from '@easydb/shared';
import { getContext } from '../app-context.js';
import { initWindowManager } from '../window-mgr/table-window-manager.js';
import { initViewWindowManager } from '../window-mgr/view-window-manager.js';

/**
 * Used to be a card-list renderer. Now it's a thin controller:
 * boots the window manager once and renders only an
 * empty-state hint when no tables exist in the current workspace.
 * The actual table UI lives in floating panels in the canvas viewport.
 */
@customElement('table-list')
export class TableList extends LitElement {
  static override styles = css`
    :host {
      display: block;
      height: 100%;
      box-sizing: border-box;
    }
    .empty {
      color: #6b7280;
      text-align: center;
      padding: 4rem 1rem;
      font-size: 0.95rem;
    }
  `;

  @state() private tables: Table[] = [];
  private unsubscribe?: () => void;
  private workspaceId = '';

  override async connectedCallback() {
    super.connectedCallback();
    const ctx = await getContext();
    this.workspaceId = ctx.workspaceId;
    this.unsubscribe = ctx.store.tables.subscribe(
      (t) => (this.tables = t.filter((x) => x.workspaceId === this.workspaceId)),
    );
    const all = await ctx.store.tables.find();
    this.tables = all.filter((t) => t.workspaceId === this.workspaceId);
    await initWindowManager();
    await initViewWindowManager();
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this.unsubscribe?.();
  }

  override render() {
    if (this.tables.length > 0) return html``;
    return html`<div class="empty">
      No tables yet. Drop a <strong>.csv</strong> or <strong>.json</strong> file anywhere on the
      page, or click <strong>+ New Table</strong> above.
    </div>`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'table-list': TableList;
  }
}
