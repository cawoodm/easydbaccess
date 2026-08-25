import { LitElement, css, html } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import type { Workspace } from '@easydb/shared';
import { getContext } from '../app-context.js';
import { mergeWorkspaceList, readFolderIndex, workspaceLabel, type ListEntry } from '../db/edb/folder-index.js';
import { ACTIVE_FILE_CHANGED_EVENT, activeEdbName, adoptedFileName } from '../db/edb/session.js';
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
  /**
   * The workspaces the connected folder holds in OTHER files, merged in.
   *
   * Read from the device-local index rather than any database, because a
   * workspace list is a table inside one file and this tab holds one file. See
   * `db/edb/folder-index.ts`.
   */
  @state() private entries: ListEntry[] = [];
  private unsubscribe?: () => void;
  private readonly onIndexChanged = () => this.remerge();

  override async connectedCallback() {
    super.connectedCallback();
    const ctx = await getContext();
    this.current = ctx.workspaceId;
    this.unsubscribe = ctx.store.workspaces.subscribe((ws) => {
      this.workspaces = ws;
      this.remerge();
    });
    this.workspaces = await ctx.store.workspaces.find();
    this.remerge();
    // A folder sync rewrites the index while this element is already mounted, and
    // the index is not a store nothing can subscribe to.
    window.addEventListener('easydb:folder-index-changed', this.onIndexChanged);
    // A first Save adopts a file without reloading, and the tooltip names it.
    window.addEventListener(ACTIVE_FILE_CHANGED_EVENT, this.onIndexChanged);
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this.unsubscribe?.();
    window.removeEventListener('easydb:folder-index-changed', this.onIndexChanged);
    window.removeEventListener(ACTIVE_FILE_CHANGED_EVENT, this.onIndexChanged);
  }

  private remerge() {
    this.entries = mergeWorkspaceList(this.workspaces, readFolderIndex()?.workspaces ?? [], activeEdbName());
  }

  /**
   * What to say on hover: the file this workspace lives in.
   *
   * An entry from another file carries its own name. Everything else is in the
   * database this tab has open, which is a file too whenever one was adopted —
   * the project index (`index.edp`) is not, and calling it by name would send the
   * user looking for a file they never chose and cannot open.
   */
  private whereItLives(e: ListEntry): string {
    if (e.file) return e.file;
    return adoptedFileName() ?? 'Stored in this browser';
  }

  /**
   * Switch by NAME through `?space=`, which is what makes a workspace in another
   * file reachable: the boot resolution finds that file and adopts it
   * (`db/edb/space-resolve.ts`). Nothing here has to know where it lives.
   */
  private switchWorkspace(value: string) {
    const entry = this.entries.find((e) => `${e.id}\u0000${e.file ?? ''}` === value);
    if (entry) openWorkspace(entry.name);
  }

  /**
   * The TITLE is what a workspace is called, so it is what the list shows
   * (`workspaceLabel`). The store subscription above re-runs on any write to
   * `workspaces`, so a title edited in Settings reaches this list with nothing else
   * to wire up. Each option's VALUE stays keyed on the id — a title is not
   * routable, and two workspaces may share one.
   *
   * The FILE is a tooltip, never part of the text. A list of
   * "workspace ┈ workspace.edb" is a list of names read twice, and the file name
   * matters only when the user is asking which of two copies they are about to
   * open — which is what hovering answers.
   *
   * EVERY entry gets one, including the open workspace. `ListEntry.file` is set
   * only for the ones in other files (that is what makes them a switch), so the
   * open database's own name has to come from the session — otherwise hovering the
   * workspace you are actually in answered nothing, which is the one you are most
   * likely to be asking about.
   */
  override render() {
    return html`
      <select @change=${(e: Event) => this.switchWorkspace((e.target as HTMLSelectElement).value)}>
        ${this.entries.map(
          (e) => html`<option value=${`${e.id}\u0000${e.file ?? ''}`} title=${this.whereItLives(e)} ?selected=${e.file === undefined && e.id === this.current}>${workspaceLabel(e)}</option>`,
        )}
      </select>
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
