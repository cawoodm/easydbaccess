import { LitElement, css, html } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import type { Workspace } from '@easydb/shared';
import { getContext } from '../app-context.js';

@customElement('workspace-selector')
export class WorkspaceSelector extends LitElement {
  static override styles = css`
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
  `;

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

  private async addWorkspace() {
    const name = prompt('Workspace name?');
    if (!name) return;
    const ctx = await getContext();
    const id = name.toLowerCase().replace(/[^a-z0-9-]/g, '-');
    await ctx.store.workspaces.insert({
      id,
      name,
      createdAt: Date.now(),
      pluginUrls: [],
    });
  }

  override render() {
    return html`
      <select .value=${this.current}>
        ${this.workspaces.map((w) => html`<option value=${w.id}>${w.name}</option>`)}
      </select>
      <button @click=${this.addWorkspace} title="New workspace">+</button>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'workspace-selector': WorkspaceSelector;
  }
}
