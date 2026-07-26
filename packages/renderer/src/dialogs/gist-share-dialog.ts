// packages/renderer/src/dialogs/gist-share-dialog.ts
//
// "Share workspace" dialog: shows a `?gist=` share link (a base64'd gist
// connection string) with a copy button and a caution that the link embeds
// the user's GitHub token. Lazy-loaded via dynamic import() from gist-sync.ts
// so it never registers its custom element unless a user actually shares.

import { LitElement, css, html } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { dialogChromeStyles } from './dialog-chrome.js';
import { makeDialogDraggable } from './draggable.js';

let singleton: GistShareDialog | null = null;
function host(): GistShareDialog {
  if (!singleton) {
    singleton = document.createElement('gist-share-dialog') as GistShareDialog;
    document.body.appendChild(singleton);
  }
  return singleton;
}

@customElement('gist-share-dialog')
export class GistShareDialog extends LitElement {
  /** Self-mounting singleton — the caller doesn't need to place the element. */
  static open(link: string): Promise<void> {
    return host().openDialog(link);
  }

  static override styles = [
    dialogChromeStyles,
    css`
      dialog {
        min-width: 420px;
        max-width: 560px;
      }
      .link-row {
        display: flex;
        gap: 0.5rem;
      }
      input.link {
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        font-size: 0.8rem;
        padding: 0.45rem 0.55rem;
        border: 1px solid #d1d5db;
        border-radius: 0.25rem;
        width: 100%;
        box-sizing: border-box;
        background: white;
      }
      button.ghost.copy {
        white-space: nowrap;
      }
      .caution {
        color: #b45309;
        font-size: 0.82rem;
        line-height: 1.5;
        margin: 0;
        background: #fffbeb;
        border: 1px solid #fde68a;
        border-radius: 0.3rem;
        padding: 0.55rem 0.7rem;
      }
    `,
  ];

  @state() private link = '';
  @state() private copyLabel = 'Copy';

  private dialogEl: HTMLDialogElement | null = null;
  private resolveFn: (() => void) | null = null;

  override connectedCallback(): void {
    super.connectedCallback();
  }

  override firstUpdated(): void {
    this.dialogEl = this.shadowRoot?.querySelector('dialog') ?? null;
    const header = this.shadowRoot?.querySelector('.dialog-header') as HTMLElement | null;
    if (this.dialogEl && header) makeDialogDraggable(this.dialogEl, header);
  }

  private openDialog(link: string): Promise<void> {
    this.link = link;
    this.copyLabel = 'Copy';
    return new Promise<void>((resolve) => {
      this.resolveFn = resolve;
      void this.updateComplete.then(() => {
        this.dialogEl?.showModal();
        const input = this.shadowRoot?.querySelector('input.link') as HTMLInputElement | null;
        input?.focus();
        input?.select();
      });
    });
  }

  private finish(): void {
    this.dialogEl?.close();
    const resolve = this.resolveFn;
    this.resolveFn = null;
    queueMicrotask(() => resolve?.());
  }

  private onCancel = (e: Event): void => {
    e.preventDefault();
    this.finish();
  };

  private onFocusInput = (e: Event): void => {
    (e.target as HTMLInputElement).select();
  };

  private copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(this.link);
      this.copyLabel = 'Copied!';
    } catch {
      this.copyLabel = 'Copy failed';
    }
    setTimeout(() => {
      this.copyLabel = 'Copy';
    }, 1500);
  };

  override render() {
    return html`
      <dialog @cancel=${this.onCancel}>
        <button type="button" class="close-x" title="Close" @click=${() => this.finish()}>×</button>
        <form @submit=${(e: Event) => e.preventDefault()}>
          <div class="dialog-header">
            <h2>Share workspace</h2>
            <div class="header-actions">
              <button type="button" class="primary" @click=${() => this.finish()}>Close</button>
            </div>
          </div>
          <div class="dialog-body">
            <div class="link-row">
              <input
                class="link"
                type="text"
                readonly
                .value=${this.link}
                @focus=${this.onFocusInput}
              />
              <button type="button" class="ghost copy" @click=${() => void this.copy()}>
                ${this.copyLabel}
              </button>
            </div>
            <p class="caution">
              ⚠ This link contains your GitHub token — anyone you send it to can read and modify
              your gists. Only share it with people you trust.
            </p>
          </div>
        </form>
      </dialog>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'gist-share-dialog': GistShareDialog;
  }
}
