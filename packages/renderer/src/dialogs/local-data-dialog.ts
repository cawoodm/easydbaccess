// packages/renderer/src/dialogs/local-data-dialog.ts
//
// The "Local Data" half of the Connect menu: which folder this browser may use,
// and which of the `.edb` files in it are in play.
//
// Connect used to mean one thing — point a window at somebody else's live table
// and store nothing. It now has two halves, and this is the other: where YOUR
// workspaces live. They share a button because "connect" is the same question
// from the user's side ("what data can this app reach?"), and they stay separate
// dialogs because nothing else about them is alike.
//
// **Switching a file off is not a view filter.** The file is not read, not
// parsed, not conflict-checked and never written — `scanFolder` skips it before
// it opens anything. Only the NAME is collected, which is what this dialog
// lists, and is the whole reason a switched-off file can be switched back on.
// See `db/edb/folder-index.ts` for the rule and `db/edb/folder-sync.ts` for
// where it bites.
//
// The one file that can never be switched off is the one this tab has OPEN. Its
// workspace is live — the store, the panels and every plugin are bound to it —
// so its row is ticked and disabled rather than pretending to be a choice.
//
// The actions come in as callbacks rather than being imported: connecting a
// folder, rescanning and opening a file all live inside the `edb-file` plugin's
// session closure, which owns the autosave state and the save button they
// disturb. Same shape as `folder-sync.ts`, which takes its writes the same way
// and for the same reason.

import { LitElement, css, html, nothing } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { ctrlEnterSubmits, dialogChromeStyles, makeDialogDraggable } from '@marccawood/lit-dialogs';
import { materialIconStyles } from '../chrome/material-icon-css.js';
import { canPickFolder, rememberedFolder } from '../db/edb/file-handle.js';
import { activeEdbName } from '../db/edb/session.js';
import { backendActiveFile } from '../db/file-workspaces.js';
import { readFolderIndex, readFolderSelection, workspaceLabel, writeFolderSelection, type FolderSelection, type FolderWorkspace } from '../db/edb/folder-index.js';

/** What the dialog cannot do for itself — see the module header. */
export interface LocalDataActions {
  /** Grant a workspace folder, or swap the granted one. */
  chooseFolder(): Promise<void>;
  /** Forget the folder grant, leaving every file on disk untouched. */
  disconnectFolder(): Promise<void>;
  /** Re-read the folder and rebuild the index. */
  rescan(): Promise<void>;
  /** The file picker, for a `.edb` that is not in the folder at all. */
  openFile(): Promise<void>;
  /**
   * Whether this build can take a whole folder at all.
   *
   * The dialog is shared, so it may not test for a browser API to find out: the
   * desktop reaches a folder through the main process and would fail that test
   * while being perfectly able to. Absent means "ask the browser", which is what
   * this did before the desktop had a folder.
   */
  canConnectFolder?(): boolean;
  /** Said in place of the folder controls when {@link canConnectFolder} is false. */
  noFolderReason?: string | undefined;
  /** The line under "Open a workspace file…". Each build grants a file differently. */
  openFileHint?: string | undefined;
}

/** What the browser says when it has no directory picker. */
const NO_FOLDER_HERE = 'This browser cannot hand over a whole folder — the directory picker is Chromium-only. You can still open a single workspace file below, and in this browser it opens read-only.';

/** What the browser says about a file outside the folder. */
const OPEN_FILE_HINT = 'The browser grants this app that one file, and remembers it across reloads.';

let actions: LocalDataActions | null = null;

/**
 * Open the dialog. `a` is remembered, so the Connect menu can open it later
 * without the plugin handing its callbacks over again.
 */
export function openLocalDataDialog(a?: LocalDataActions): void {
  if (a) actions = a;
  const el = LocalDataDialog.instance ?? mount();
  void el.show();
}

function mount(): LocalDataDialog {
  const el = document.createElement('local-data-dialog') as LocalDataDialog;
  document.body.appendChild(el);
  return el;
}

/** One row: a file in the folder, and the workspace in it if we have ever read one. */
interface FileRow {
  file: string;
  workspace?: FolderWorkspace | undefined;
}

/** "2 minutes ago", for the scan time. Coarse on purpose — the exact second means nothing here. */
function ago(at: number): string {
  const secs = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (secs < 60) return 'just now';
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'} ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

/** Bytes as something readable. */
function size(bytes: number | undefined): string {
  if (bytes === undefined) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

@customElement('local-data-dialog')
export class LocalDataDialog extends LitElement {
  static instance: LocalDataDialog | null = null;

  static override styles = [
    dialogChromeStyles,
    materialIconStyles,
    css`
      dialog {
        min-width: 460px;
        max-width: 620px;
      }
      .folder {
        display: flex;
        align-items: center;
        gap: 0.5rem;
        padding: 0.6rem;
        background: #f3f4f6;
        border-radius: 0.35rem;
        font-size: 0.9rem;
      }
      .folder .name {
        flex: 1;
        font-weight: 600;
        color: #374151;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .folder .none {
        flex: 1;
        color: #6b7280;
        font-weight: 400;
      }
      .hint {
        margin: 0.5rem 0 0;
        color: #6b7280;
        font-size: 0.85rem;
        line-height: 1.45;
      }
      .all {
        display: flex;
        align-items: center;
        gap: 0.45rem;
        margin: 0.9rem 0 0.4rem;
        font-size: 0.9rem;
        font-weight: 600;
        color: #374151;
      }
      ul {
        list-style: none;
        margin: 0;
        padding: 0;
        max-height: 15rem;
        overflow-y: auto;
        border: 1px solid #e5e7eb;
        border-radius: 0.35rem;
      }
      li {
        display: flex;
        align-items: flex-start;
        gap: 0.5rem;
        padding: 0.45rem 0.6rem;
        border-bottom: 1px solid #f3f4f6;
        font-size: 0.85rem;
      }
      li:last-child {
        border-bottom: 0;
      }
      li.off {
        opacity: 0.55;
      }
      li .who {
        flex: 1;
        min-width: 0;
      }
      li .label {
        font-weight: 600;
        color: #374151;
      }
      li .facts {
        color: #6b7280;
        font-size: 0.78rem;
      }
      li .open-tag {
        flex: none;
        color: #2563eb;
        font-size: 0.75rem;
        font-weight: 600;
        white-space: nowrap;
      }
      .empty {
        padding: 0.6rem;
        color: #6b7280;
        font-size: 0.85rem;
      }
      .scanned {
        display: flex;
        align-items: center;
        gap: 0.5rem;
        margin-top: 0.6rem;
        color: #6b7280;
        font-size: 0.8rem;
      }
      .scanned .spacer {
        flex: 1;
      }
      .outside {
        margin-top: 0.9rem;
        padding-top: 0.7rem;
        border-top: 1px solid #e5e7eb;
      }
    `,
  ];

  @state() private folder: string | null = null;
  @state() private rows: FileRow[] = [];
  @state() private selection: FolderSelection = { all: true, files: [] };
  @state() private scannedAt: number | null = null;
  @state() private busy = false;
  private dialogEl: HTMLDialogElement | null = null;

  override connectedCallback(): void {
    super.connectedCallback();
    LocalDataDialog.instance = this;
  }
  override disconnectedCallback(): void {
    super.disconnectedCallback();
    if (LocalDataDialog.instance === this) LocalDataDialog.instance = null;
  }
  override firstUpdated(): void {
    this.dialogEl = this.shadowRoot?.querySelector('dialog') ?? null;
    const header = this.shadowRoot?.querySelector('.dialog-header') as HTMLElement | null;
    if (this.dialogEl && header) makeDialogDraggable(this.dialogEl, header);
  }

  async show(): Promise<void> {
    await this.reload();
    await this.updateComplete;
    if (!this.dialogEl?.open) this.dialogEl?.showModal();
  }

  /**
   * Re-read what is on disk-ish: the granted folder, the cached index, the
   * selection. Nothing here touches a file — the index is the last scan's
   * result, and rescanning is the user's button.
   */
  private async reload(): Promise<void> {
    const dir = await rememberedFolder();
    const index = readFolderIndex();
    this.folder = dir?.name ?? index?.folder ?? null;
    this.selection = readFolderSelection();
    this.scannedAt = index?.at ?? null;

    // Every name the last scan saw, plus any file a workspace names — the
    // second is the fallback for an index written before `files` existed.
    const names = new Set<string>(index?.files ?? []);
    for (const w of index?.workspaces ?? []) names.add(w.file);
    const byFile = new Map<string, FolderWorkspace>();
    for (const w of index?.workspaces ?? []) if (!byFile.has(w.file)) byFile.set(w.file, w);

    this.rows = [...names]
      .sort((a, b) => a.localeCompare(b))
      .map((file) => {
        const workspace = byFile.get(file);
        return workspace ? { file, workspace } : { file };
      });
  }

  private close = (): void => this.dialogEl?.close();

  private onSubmit = (e: Event): void => {
    e.preventDefault();
    this.close();
  };

  /** Persist and tell the workspace selector, which reads the index once. */
  private commit(next: FolderSelection): void {
    this.selection = next;
    writeFolderSelection(next);
    window.dispatchEvent(new CustomEvent('easydb:folder-index-changed'));
  }

  /**
   * "All files" is a RULE, not a tick-everything shortcut: with it on, a file
   * dropped into the folder tomorrow is used without anyone revisiting this.
   *
   * Turning it OFF seeds the list with every file currently known, so the act
   * of unticking never hides anything by itself. The user then unticks what
   * they actually want gone, which is the only order that cannot surprise them.
   */
  private onAll = (e: Event): void => {
    const all = (e.target as HTMLInputElement).checked;
    this.commit(all ? { all: true, files: [] } : { all: false, files: this.rows.map((r) => r.file) });
  };

  private onFile(file: string, on: boolean): void {
    const files = new Set(this.selection.files);
    if (on) files.add(file);
    else files.delete(file);
    this.commit({ all: false, files: [...files] });
  }

  /**
   * Run one of the plugin's actions, then re-read.
   *
   * `pick` reads the callback rather than taking it, so a dialog opened before
   * the plugin registered its actions does nothing instead of throwing: the
   * buttons are inert, the folder list still reads. `edb-file` is a fixed
   * built-in, so in practice they are always there — this is the case the type
   * allows, not one the app is expected to reach.
   */
  private async act(pick: (a: LocalDataActions) => Promise<void>): Promise<void> {
    if (this.busy || !actions) return;
    this.busy = true;
    try {
      await pick(actions);
    } finally {
      this.busy = false;
      await this.reload();
    }
  }

  private renderRow(row: FileRow) {
    // Whichever build is running says which file it has open — see
    // `workspace-selector.ts`'s `openFile` for the same pair.
    const isOpen = row.file === (backendActiveFile() ?? activeEdbName());
    const on = isOpen || this.selection.all || this.selection.files.includes(row.file);
    const w = row.workspace;
    const facts = [w?.tables === undefined ? '' : `${w.tables} table${w.tables === 1 ? '' : 's'}`, w?.views === undefined ? '' : `${w.views} view${w.views === 1 ? '' : 's'}`, size(w?.size)]
      .filter(Boolean)
      .join(' · ');
    return html`
      <li class=${on ? '' : 'off'}>
        <input
          type="checkbox"
          .checked=${on}
          ?disabled=${this.selection.all || isOpen}
          title=${isOpen ? 'This is the file you have open — it cannot be switched off' : 'Read this file and list its workspace'}
          @change=${(e: Event) => this.onFile(row.file, (e.target as HTMLInputElement).checked)}
        />
        <span class="who">
          <span class="label">${w ? workspaceLabel(w) : row.file}</span>
          <div class="facts">${w ? row.file : 'not read yet'}${facts ? ` · ${facts}` : ''}</div>
        </span>
        ${isOpen ? html`<span class="open-tag">open</span>` : nothing}
      </li>
    `;
  }

  override render() {
    const canFolder = actions?.canConnectFolder?.() ?? canPickFolder();
    return html`
      <dialog @cancel=${this.close} @keydown=${ctrlEnterSubmits}>
        <button type="button" class="close-x" title="Close" @click=${this.close}>×</button>
        <form @submit=${this.onSubmit}>
          <div class="dialog-header">
            <h2>Local Data</h2>
            <div class="header-actions">
              <button type="submit" class="ghost">Close</button>
            </div>
          </div>
          <div class="dialog-body">
            ${canFolder
              ? html`
                  <div class="folder">
                    <span class="mi sm" aria-hidden="true">folder</span>
                    ${this.folder ? html`<span class="name" title=${this.folder}>${this.folder}</span>` : html`<span class="none">No folder connected</span>`}
                    <button type="button" class="primary" ?disabled=${this.busy} @click=${() => void this.act((a) => a.chooseFolder())}>${this.folder ? 'Change…' : 'Connect…'}</button>
                    ${this.folder ? html`<button type="button" class="ghost" ?disabled=${this.busy} @click=${() => void this.act((a) => a.disconnectFolder())}>Disconnect</button>` : nothing}
                  </div>
                `
              : html`<p class="hint">${actions?.noFolderReason ?? NO_FOLDER_HERE}</p>`}
            ${this.folder
              ? html`
                  <label class="all">
                    <input type="checkbox" .checked=${this.selection.all} @change=${this.onAll} />
                    Use every .edb in this folder
                  </label>
                  <p class="hint">
                    ${this.selection.all
                      ? 'Files added to the folder later are picked up on their own.'
                      : 'Only the ticked files are read. The rest are left alone entirely — not scanned, not compared, never written.'}
                  </p>
                  ${this.rows.length === 0
                    ? html`<div class="empty">No .edb files found. Rescan after adding one.</div>`
                    : html`<ul>
                        ${this.rows.map((r) => this.renderRow(r))}
                      </ul>`}
                  <div class="scanned">
                    <span>${this.scannedAt === null ? 'Not scanned yet' : `Scanned ${ago(this.scannedAt)}`}</span>
                    <span class="spacer"></span>
                    <button type="button" class="ghost" ?disabled=${this.busy} @click=${() => void this.act((a) => a.rescan())}>Rescan</button>
                  </div>
                `
              : nothing}
            <div class="outside">
              <button type="button" class="ghost" ?disabled=${this.busy} @click=${() => void this.act((a) => a.openFile())}>Open a workspace file…</button>
              <p class="hint">For a <code>.edb</code> that is not in the folder. ${actions?.openFileHint ?? OPEN_FILE_HINT}</p>
            </div>
          </div>
        </form>
      </dialog>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'local-data-dialog': LocalDataDialog;
  }
}
