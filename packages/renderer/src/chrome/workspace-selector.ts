import { LitElement, css, html } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import type { Workspace } from '@easydb/shared';
import { getContext } from '../app-context.js';
import { materialIconStyles } from './material-icon-css.js';
// The flows themselves are shared with the command palette — see
// `workspace-actions.ts`. This element is only their mouse-driven entry point.
import { deleteWorkspaceFlow, newWorkspaceFlow, openWorkspace } from './workspace-actions.js';

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

  private switchWorkspace(id: string) {
    const ws = this.workspaces.find((w) => w.id === id);
    if (ws) openWorkspace(ws.name);
  }

  override render() {
    return html`
      <select .value=${this.current} @change=${(e: Event) => this.switchWorkspace((e.target as HTMLSelectElement).value)}>
        ${this.workspaces.map((w) => html`<option value=${w.id} ?selected=${w.id === this.current}>${w.name}</option>`)}
      </select>
      <button @click=${newWorkspaceFlow} title="New workspace">
        <span class="mi sm">add</span>
      </button>
      <button @click=${deleteWorkspaceFlow} title="Delete workspace">
        <span class="mi sm">delete</span>
      </button>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'workspace-selector': WorkspaceSelector;
  }
}
