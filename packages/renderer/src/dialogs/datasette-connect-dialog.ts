// packages/renderer/src/dialogs/datasette-connect-dialog.ts
//
// "Connect Datasette (live)" dialog: enter an instance/database/table URL and
// an optional write token, optionally test the connection, then connect. Unlike
// the Import dialog (which snapshots rows into a local table), connecting opens
// a LIVE table backed by the remote Datasette (reads through the cursor, writes
// through the JSON write API when the token grants them).

import { LitElement, css, html } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { ctrlEnterSubmits, dialogChromeStyles } from './dialog-chrome.js';
import { makeDialogDraggable } from './draggable.js';

export interface ConnectChoice {
  url: string;
  token: string;
}

export interface ConnectDialogOpts {
  /** Prefill (e.g. a remembered token for the typed base). */
  initialUrl?: string;
  initialToken?: string;
  /** Runs the "Test connection" probe; returns a human-readable status line. */
  onTest?: (url: string, token: string) => Promise<string>;
  /** Pre-flight gate run on submit; if it throws, the dialog stays open and
   *  shows the error inline instead of closing. Resolves ⇒ the dialog closes
   *  and the caller proceeds with the real connect. */
  onConnect?: (url: string, token: string) => Promise<void>;
}

const EXAMPLE = 'https://latest.datasette.io/ephemeral';

@customElement('datasette-connect-dialog')
export class DatasetteConnectDialog extends LitElement {
  static instance: DatasetteConnectDialog | null = null;

  static override styles = [
    dialogChromeStyles,
    css`
      dialog {
        min-width: 440px;
        max-width: 560px;
      }
      label {
        display: flex;
        flex-direction: column;
        gap: 0.3rem;
        font-size: 0.85rem;
        color: #374151;
      }
      input {
        font: inherit;
        padding: 0.45rem 0.55rem;
        border: 1px solid #d1d5db;
        border-radius: 0.25rem;
        width: 100%;
        box-sizing: border-box;
        background: white;
      }
      .test-row {
        display: flex;
        align-items: center;
        gap: 0.6rem;
      }
      button.ghost.test {
        white-space: nowrap;
      }
      .status {
        font-size: 0.82rem;
        color: #6b7280;
        min-height: 1.1em;
      }
      .status.ok {
        color: #15803d;
      }
      .status.err {
        color: #b91c1c;
      }
      .hint {
        color: #6b7280;
        font-size: 0.78rem;
        margin: 0;
        line-height: 1.5;
      }
      .hint code {
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        font-size: 0.72rem;
        background: #f3f4f6;
        padding: 0.05rem 0.25rem;
        border-radius: 0.2rem;
      }
    `,
  ];

  @state() private url = '';
  @state() private token = '';
  @state() private status = '';
  @state() private statusKind: '' | 'ok' | 'err' | 'busy' = '';

  private dialogEl: HTMLDialogElement | null = null;
  private resolveFn: ((v: ConnectChoice | null) => void) | null = null;
  private onTest?: ((url: string, token: string) => Promise<string>) | undefined;
  private onConnect?: ((url: string, token: string) => Promise<void>) | undefined;

  override connectedCallback(): void {
    super.connectedCallback();
    DatasetteConnectDialog.instance = this;
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    if (DatasetteConnectDialog.instance === this) DatasetteConnectDialog.instance = null;
  }

  override firstUpdated(): void {
    this.dialogEl = this.shadowRoot?.querySelector('dialog') ?? null;
    const header = this.shadowRoot?.querySelector('.dialog-header') as HTMLElement | null;
    if (this.dialogEl && header) makeDialogDraggable(this.dialogEl, header);
  }

  open(opts: ConnectDialogOpts = {}): Promise<ConnectChoice | null> {
    this.url = opts.initialUrl ?? '';
    this.token = opts.initialToken ?? '';
    this.status = '';
    this.statusKind = '';
    this.onTest = opts.onTest;
    this.onConnect = opts.onConnect;
    return new Promise<ConnectChoice | null>((resolve) => {
      this.resolveFn = resolve;
      void this.updateComplete.then(() => this.dialogEl?.showModal());
    });
  }

  private finish(value: ConnectChoice | null): void {
    this.dialogEl?.close();
    const resolve = this.resolveFn;
    this.resolveFn = null;
    queueMicrotask(() => resolve?.(value));
  }

  private onCancel = (e: Event): void => {
    e.preventDefault();
    this.finish(null);
  };

  private async runTest(): Promise<void> {
    const url = this.url.trim();
    if (!url || !this.onTest) return;
    this.status = 'Testing…';
    this.statusKind = 'busy';
    try {
      this.status = await this.onTest(url, this.token.trim());
      this.statusKind = /read-write|reachable|ok\b/i.test(this.status) ? 'ok' : 'err';
    } catch (err) {
      this.status = (err as Error)?.message ?? String(err);
      this.statusKind = 'err';
    }
  }

  private submit = async (e: Event): Promise<void> => {
    e.preventDefault();
    const url = this.url.trim();
    if (!url) return;
    const token = this.token.trim();
    if (this.onConnect) {
      this.status = 'Checking…';
      this.statusKind = 'busy';
      try {
        await this.onConnect(url, token);
      } catch (err) {
        // Keep the dialog open so the user can fix the URL — show the failure
        // inline instead of closing and firing a separate alert.
        this.status = (err as Error)?.message ?? String(err);
        this.statusKind = 'err';
        return;
      }
    }
    this.finish({ url, token });
  };

  override render() {
    return html`
      <dialog @cancel=${this.onCancel} @keydown=${ctrlEnterSubmits}>
        <button type="button" class="close-x" title="Close" @click=${() => this.finish(null)}>×</button>
        <form @submit=${this.submit}>
          <div class="dialog-header">
            <h2>Connect Datasette</h2>
            <div class="header-actions">
              <button type="button" class="ghost" @click=${() => this.finish(null)}>Cancel</button>
              <button type="submit" class="primary">Connect</button>
            </div>
          </div>
          <div class="dialog-body">
            <label>
              URL — a table, a database, or an instance
              <input
                type="text"
                autofocus
                placeholder="e.g. ${EXAMPLE}"
                .value=${this.url}
                @input=${(e: Event) => {
                  this.url = (e.target as HTMLInputElement).value;
                  this.status = '';
                  this.statusKind = '';
                }}
              />
            </label>
            <label>
              Write token (optional)
              <input
                type="password"
                placeholder="dstok_…  — leave blank for read-only"
                .value=${this.token}
                @input=${(e: Event) => {
                  this.token = (e.target as HTMLInputElement).value;
                }}
              />
            </label>
            <div class="test-row">
              <button type="button" class="ghost test" @click=${() => void this.runTest()}>
                Test connection
              </button>
              <span class="status ${this.statusKind}">${this.status}</span>
            </div>
            <p class="hint">
              Enter a single table (<code>…/db/table</code>), a whole database (<code>…/db</code>),
              or an instance root — you'll pick which tables to connect. Opens live tables backed by
              the remote Datasette: reads stay remote, and edits write back when the token grants
              them. The token is stored on this device only and is never synced or exported. A blank
              token opens tables read-only.
            </p>
          </div>
        </form>
      </dialog>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'datasette-connect-dialog': DatasetteConnectDialog;
  }
}
