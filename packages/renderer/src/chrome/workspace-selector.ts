import { LitElement, css, html } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import type { Workspace } from '@easydb/shared';
import { getContext } from '../app-context.js';
import { materialIconStyles } from './material-icon-css.js';

@customElement('workspace-selector')
export class WorkspaceSelector extends LitElement {
  static override styles = [
    materialIconStyles,
    css`
    :host {
      display: inline-flex;
      align-items: center;
      gap: 0.5rem;
    }
    select,
    button {
      background: #374151;
      color: white;
      border: 1px solid #4b5563;
      padding: 0.25rem 0.5rem;
      border-radius: 0.25rem;
      font: inherit;
    }
    button:hover {
      background: #4b5563;
    }
    .mi.sm {
      font-size: 1rem;
    }
  `,
  ];

  @state() private workspaces: Workspace[] = [];
  @state() private current = '';
  private unsubscribe?: () => void;

  override async connectedCallback() {
    super.connectedCallback();
    const ctx = await getContext();
    this.current = ctx.workspaceId;
    this.unsubscribe = ctx.store.workspaces.subscribe((ws) => (this.workspaces = ws));
    this.workspaces = await ctx.store.workspaces.find();
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this.unsubscribe?.();
  }

  /**
   * Switch by reloading with ?space=<name>. Reload is the cleanest cut here
   * — Dexie tables, panel windows, and the plugin host all bind to a
   * single workspaceId at boot, so swapping it live would require tearing
   * down every panel and rebinding every subscription.
   */
  private switchWorkspace(id: string) {
    const ws = this.workspaces.find((w) => w.id === id);
    if (!ws) return;
    const sp = new URLSearchParams(location.search);
    sp.set('space', ws.name);
    const url = `${location.pathname}?${sp.toString()}${location.hash}`;
    location.assign(url);
  }

  private async addWorkspace() {
    const ctx = await getContext();
    const name = await ctx.api.ui.dialogs.prompt(
      'Name the new workspace. It will become active after creation.',
      '',
      'New workspace',
    );
    if (!name || !name.trim()) return;
    // Navigate to the new workspace — init() will create it on first load
    // since it doesn't exist yet.
    const sp = new URLSearchParams(location.search);
    sp.set('space', name.trim());
    location.assign(`${location.pathname}?${sp.toString()}${location.hash}`);
  }

  override render() {
    return html`
      <select
        .value=${this.current}
        @change=${(e: Event) => this.switchWorkspace((e.target as HTMLSelectElement).value)}
      >
        ${this.workspaces.map(
          (w) => html`<option value=${w.id} ?selected=${w.id === this.current}>${w.name}</option>`,
        )}
      </select>
      <button @click=${this.addWorkspace} title="New workspace">
        <span class="mi sm">add</span>
      </button>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'workspace-selector': WorkspaceSelector;
  }
}
