import { LitElement, css, html } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { getContext } from '../app-context.js';
import { listLabels, type ListEntry } from '../db/edb/folder-index.js';
import { INDEX_SPACES_CHANGED_EVENT, recordOpenWorkspaces, workspaceList } from '../db/edb/space-registry.js';
import { ACTIVE_FILE_CHANGED_EVENT } from '../db/edb/session.js';
import { SETTINGS_CHANGED_EVENT } from '../db/settings-events.js';
import { openDatabaseName } from '../db/file-workspaces.js';
import { materialIconStyles } from './material-icon-css.js';
// The flows themselves are shared with the command palette — see
// `workspace-actions.ts`. This element is only their mouse-driven entry point.
import { deleteWorkspaceFlow, newWorkspaceFlow, openListEntry } from './workspace-actions.js';

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

  @state() private current = '';
  /**
   * The whole list, and **nothing in it comes out of the open database.**
   *
   * It is read from the folder index and the space registry — both device/folder
   * metadata (`db/edb/space-registry.ts`). A list built even partly from
   * `store.workspaces` was a property of whichever database this tab happened to
   * hold, so it changed every time the user switched workspace. That was the
   * report, twice.
   */
  @state() private entries: ListEntry[] = [];
  private unsubscribe?: () => void;
  private readonly onIndexChanged = () => this.remerge();
  /**
   * The tab has changed which file it is backed by, WITHOUT a reload.
   *
   * The first Save is the one that does it: it copies the workspace out of the
   * project index into its own `.edb` and adopts that file where it stands. The
   * registry still has the workspace filed under `index.edp` at that moment, so
   * re-reading the list alone would go on saying it is stored in this browser —
   * about a file whose name the Save toast has just quoted. Recording it under the
   * new database name is what puts the two in step.
   */
  private readonly onActiveFileChanged = () => {
    void (async () => {
      const ctx = await getContext();
      recordOpenWorkspaces(openDatabaseName(), await ctx.store.workspaces.find());
      this.remerge();
    })();
  };

  override async connectedCallback() {
    super.connectedCallback();
    const ctx = await getContext();
    this.current = ctx.workspaceId;
    // The subscription RECORDS, it does not list. Creating, renaming and deleting
    // a workspace all land here, and the registry is what carries that to the tabs
    // and reloads that will not have this database open.
    this.unsubscribe = ctx.store.workspaces.subscribe((ws) => {
      recordOpenWorkspaces(openDatabaseName(), ws);
      this.remerge();
    });
    recordOpenWorkspaces(openDatabaseName(), await ctx.store.workspaces.find());
    this.remerge();
    // A folder sync rewrites the index while this element is already mounted, and
    // the index is not a store nothing can subscribe to.
    window.addEventListener('easydb:folder-index-changed', this.onIndexChanged);
    // A first Save adopts a file without reloading, and the tooltip names it.
    window.addEventListener(ACTIVE_FILE_CHANGED_EVENT, this.onActiveFileChanged);
    // Same reason, for the other half of the list.
    window.addEventListener(INDEX_SPACES_CHANGED_EVENT, this.onIndexChanged);
    // Adopting a folder swaps the device layer under both of them — what the
    // folder's `_easydb.edp` holds wins over what this browser had — so the list
    // has to be read again once that has happened.
    window.addEventListener(SETTINGS_CHANGED_EVENT, this.onIndexChanged);
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this.unsubscribe?.();
    window.removeEventListener('easydb:folder-index-changed', this.onIndexChanged);
    window.removeEventListener(ACTIVE_FILE_CHANGED_EVENT, this.onActiveFileChanged);
    window.removeEventListener(INDEX_SPACES_CHANGED_EVENT, this.onIndexChanged);
    window.removeEventListener(SETTINGS_CHANGED_EVENT, this.onIndexChanged);
  }

  private remerge() {
    this.entries = workspaceList(openDatabaseName());
  }

  /**
   * What to say on hover: the file this workspace lives in.
   *
   * An entry carries its own file whenever one holds it — including the file this
   * tab has open, which is no longer a special case. Everything left is a
   * workspace the project index holds, and the project index is not a file the
   * user has.
   */
  private whereItLives(e: ListEntry): string {
    return e.file ?? 'Stored in this browser';
  }

  /**
   * Switch to whichever entry that option stands for.
   *
   * The option's value is `id` + `file`, because neither alone identifies a row:
   * the list deliberately shows two copies of one workspace when the folder holds
   * one and this database holds another, and a title is not unique either — two
   * files can both be titled "Simon".
   *
   * That pair is then what gets ACTED on. It used to be resolved back to the entry
   * and thrown away again — `openWorkspace(entry.name)` — which put the file the
   * user had just distinguished beyond the reach of everything downstream, so boot
   * re-derived a file from the name and both copies opened the same one. See
   * `openListEntry`.
   */
  private switchWorkspace(value: string) {
    const entry = this.entries.find((e) => `${e.id}\u0000${e.file ?? ''}` === value);
    if (entry) void openListEntry(entry);
  }

  /**
   * The TITLE is what a workspace is called, so it is what the list shows
   * (`workspaceLabel`). The store subscription above re-runs on any write to
   * `workspaces`, so a title edited in Settings reaches this list with nothing else
   * to wire up. Each option's VALUE stays keyed on the id AND the file — a title
   * is not routable and two workspaces may share one, and the file is what tells
   * two copies of one workspace apart.
   *
   * The FILE is a tooltip, never part of the text. A list of
   * "workspace ┈ workspace.edb" is a list of names read twice, and the file name
   * matters only when the user is asking which of two copies they are about to
   * open — which is what hovering answers. Where hovering CANNOT answer it, because
   * two rows come out of one file, `listLabels` qualifies the text itself.
   *
   * EVERY entry gets one, including the open workspace — its row now carries the
   * file that holds it like any other, because the list no longer treats "the one
   * this tab has open" as a different kind of thing.
   *
   * Which is also why `selected` is matched on the ID ALONE. It used to require
   * `file === undefined` as well, on the grounds that the open workspace was the
   * one row without a file; now that a row can carry one, that test would never
   * match and the select would fall back to its first option — so the header would
   * name a workspace the user is not in.
   */
  override render() {
    const labels = listLabels(this.entries);
    return html`
      <select @change=${(e: Event) => this.switchWorkspace((e.target as HTMLSelectElement).value)}>
        ${this.entries.map(
          (e, i) => html`<option value=${`${e.id}\u0000${e.file ?? ''}`} title=${this.whereItLives(e)} ?selected=${e.id === this.current}>${labels[i]}</option>`,
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
