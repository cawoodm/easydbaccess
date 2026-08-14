import { LitElement, css, html, svg } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import type { Workspace } from '@easydb/shared';
import { getContext } from '../app-context.js';
import { knownWorkspaces } from '../db/edb/registry.js';
import { materialIconStyles } from './material-icon-css.js';
// The flows themselves are shared with the command palette — see
// `workspace-actions.ts`. This element is only their mouse-driven entry point.
import { deleteWorkspaceFlow, newWorkspaceFlow, openWorkspace } from './workspace-actions.js';

/**
 * The database cylinder, for the workspace that is open.
 *
 * The same drawing as the `edb-file` and `electron-db` plugins use for their File
 * button, because it is the same idea — this workspace is a database file. Inline
 * SVG rather than a Material Icons ligature: that font has no `database` glyph
 * (`storage` draws stacked bars), which is why the File button borrows `storage`.
 */
const DATABASE_ICON = svg`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
  <ellipse cx="12" cy="5" rx="8" ry="3" />
  <path d="M4 5v6c0 1.66 3.58 3 8 3s8-1.34 8-3V5" />
  <path d="M4 11v6c0 1.66 3.58 3 8 3s8-1.34 8-3v-6" />
</svg>`;

/**
 * The same mark inside the list, where only text is possible.
 *
 * An `<option>` cannot hold an element, so the cylinder cannot go in the list
 * itself. U+26C1 is the stacked-disc glyph that has meant "database" since long
 * before the icon fonts, it is monochrome so it matches the option text, and it
 * is in the Windows and macOS system fonts.
 */
const DB_MARK = '⛁';

/** The ids of workspaces kept in a `.edb`, for the marker beside the name. */
function fileIds(): Set<string> {
  return new Set(
    knownWorkspaces()
      .filter((w) => w.file !== null)
      .map((w) => w.id),
  );
}

/**
 * The active store's workspaces, plus every one it cannot see.
 *
 * Storage is per workspace, so no single store holds the whole list: a load on
 * IndexedDB cannot see what is in a `.edb`, and a load on a `.edb` never opens
 * IndexedDB at all. Listing only the active store is what made every other
 * workspace disappear the moment one was moved into a file.
 *
 * The entries added here are placeholders for the `<option>` only — `createdAt`
 * and `pluginUrls` are never read from them, because selecting one reloads and
 * the real record then comes out of its own store.
 */
function withKnownWorkspaces(fromStore: Workspace[]): Workspace[] {
  const seen = new Set(fromStore.map((w) => w.id));
  const extra = knownWorkspaces()
    .filter((w) => !seen.has(w.id))
    .map((w) => ({ id: w.id, name: w.name, createdAt: 0, pluginUrls: [] }));
  return [...fromStore, ...extra].sort((a, b) => a.name.localeCompare(b.name));
}

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
      /* The cylinder beside the list, sized to the text it sits with. */
      .db {
        display: inline-flex;
        align-items: center;
        color: #93c5fd;
      }
      .db svg {
        width: 1rem;
        height: 1rem;
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
    this.unsubscribe = ctx.store.workspaces.subscribe((ws) => (this.workspaces = withKnownWorkspaces(ws)));
    this.workspaces = withKnownWorkspaces(await ctx.store.workspaces.find());
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this.unsubscribe?.();
  }

  /** The listed name for `id`, for the cylinder's tooltip. */
  private nameOf(id: string): string {
    return this.workspaces.find((w) => w.id === id)?.name ?? id;
  }

  private switchWorkspace(id: string) {
    const ws = this.workspaces.find((w) => w.id === id);
    if (ws) openWorkspace(ws.name);
  }

  override render() {
    const inFile = fileIds();
    return html`
      <select .value=${this.current} @change=${(e: Event) => this.switchWorkspace((e.target as HTMLSelectElement).value)}>
        ${this.workspaces.map((w) => html`<option value=${w.id} ?selected=${w.id === this.current}>${inFile.has(w.id) ? `${DB_MARK} ` : ''}${w.name}</option>`)}
      </select>
      ${inFile.has(this.current) ? html`<span class="db" title=${`"${this.nameOf(this.current)}" is kept in a .edb file`}>${DATABASE_ICON}</span>` : ''}
      <button @click=${newWorkspaceFlow} title="New workspace">
        <span class="mi sm">add</span>
      </button>
      <button @click=${deleteWorkspaceFlow} title="Delete this workspace">
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
