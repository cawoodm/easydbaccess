// packages/renderer/src/dialogs/danger-confirm.ts
//
// The red one. A two-step confirmation for an action that destroys data.
//
// Not `api.ui.dialogs.confirm`, and not because that dialog is bad: it is the one
// every ordinary yes/no in this app uses, so it is the one users answer without
// reading. An irreversible write needs to look nothing like it — a red header, a
// ⚠ the size of the text, the safe answer focused, and the dangerous answer
// asked for TWICE with the second question worded as the consequence rather than
// the action.
//
// Self-mounting, like `AnchoredMenu`: one call, no element to place in the shell
// and no `define…()` to remember. The element is removed when it closes, because
// it is opened once in a blue moon and a live element per app would outlive every
// reason it exists.
//
// The chrome comes from `@marccawood/lit-dialogs` with its `--dlg-*` tokens
// re-pointed at red, so the layout stays the app's and only the colour changes.

import { LitElement, css, html } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { dialogChromeStyles } from '@marccawood/lit-dialogs';

export interface DangerConfirmRequest {
  title: string;
  /** The first question. Newlines are kept. */
  message: string;
  /** The second question, asked only after the first is confirmed. */
  secondMessage: string;
  /** The dangerous button, step one. Name the ACTION. */
  confirmLabel: string;
  /** The dangerous button, step two. Name the LOSS. */
  secondConfirmLabel: string;
}

@customElement('danger-confirm')
export class DangerConfirm extends LitElement {
  static override styles = [
    dialogChromeStyles,
    css`
      :host {
        /* Only the colour is overridden — the layout stays the app's. */
        --dlg-header-bg: #7f1d1d;
        --dlg-header-fg: #fff;
        --dlg-accent: #b91c1c;
        --dlg-accent-hover: #991b1b;
        --dlg-accent-fg: #fff;
      }
      dialog {
        width: 30rem;
        max-width: 92vw;
        border: 2px solid #b91c1c;
      }
      .row {
        display: flex;
        gap: 0.85rem;
        align-items: flex-start;
      }
      .mark {
        font-size: 2.2rem;
        line-height: 1;
        color: #b91c1c;
        flex: 0 0 auto;
      }
      .body-text {
        margin: 0;
        white-space: pre-wrap;
        font-size: 0.92rem;
        color: #111827;
      }
      .step {
        margin: 0 0 0.5rem;
        font-size: 0.75rem;
        font-weight: 700;
        letter-spacing: 0.06em;
        text-transform: uppercase;
        color: #b91c1c;
      }
      /* The safe answer is the wide one, and it is what Enter and Esc do. */
      .actions {
        display: flex;
        gap: 0.5rem;
        justify-content: flex-end;
        margin-top: 1.1rem;
      }
      button {
        font: inherit;
        border-radius: 0.25rem;
        padding: 0.45rem 0.9rem;
        cursor: pointer;
      }
      button.safe {
        background: #f3f4f6;
        border: 1px solid #9ca3af;
        color: #111827;
        font-weight: 600;
      }
      button.safe:hover {
        background: #e5e7eb;
      }
      button.destroy {
        background: #b91c1c;
        border: 1px solid #991b1b;
        color: #fff;
      }
      button.destroy:hover {
        background: #991b1b;
      }
    `,
  ];

  /** 1 = the first question, 2 = the second. */
  @state() private step: 1 | 2 = 1;
  private req: DangerConfirmRequest | null = null;
  private settle: ((ok: boolean) => void) | null = null;
  private dialogEl: HTMLDialogElement | null = null;

  ask(req: DangerConfirmRequest): Promise<boolean> {
    this.req = req;
    this.step = 1;
    return new Promise<boolean>((resolve) => {
      this.settle = resolve;
      void this.updateComplete.then(() => {
        this.dialogEl = this.shadowRoot?.querySelector('dialog') ?? null;
        this.dialogEl?.showModal();
        // The SAFE button takes focus, so a held Enter cannot walk through both
        // steps. Every other dialog in the app focuses its primary action.
        (this.shadowRoot?.querySelector('button.safe') as HTMLButtonElement | null)?.focus();
      });
    });
  }

  private done(ok: boolean): void {
    this.dialogEl?.close();
    const settle = this.settle;
    this.settle = null;
    settle?.(ok);
  }

  /** Esc, the backdrop, the close-X and Cancel all mean NO. */
  private onCancel = (e: Event): void => {
    e.preventDefault();
    this.done(false);
  };

  private onDestroy = (): void => {
    if (this.step === 1) {
      this.step = 2;
      // Re-focus the safe button on the new step: without this, focus stays on
      // the destructive button that has just moved under the pointer, and a
      // second Enter or a double-click goes straight through.
      void this.updateComplete.then(() => (this.shadowRoot?.querySelector('button.safe') as HTMLButtonElement | null)?.focus());
      return;
    }
    this.done(true);
  };

  override render() {
    const req = this.req;
    if (!req) return html``;
    const second = this.step === 2;
    return html`
      <dialog @cancel=${this.onCancel}>
        <button type="button" class="close-x" title="Cancel" @click=${() => this.done(false)}>
          <span aria-hidden="true">×</span>
        </button>
        <div class="dialog-header">
          <h2>⚠ ${req.title}</h2>
        </div>
        <div class="dialog-body">
          <p class="step">${second ? 'Confirm again — step 2 of 2' : 'Step 1 of 2'}</p>
          <div class="row">
            <div class="mark" aria-hidden="true">❗</div>
            <p class="body-text" role="alert">${second ? req.secondMessage : req.message}</p>
          </div>
          <div class="actions">
            <button type="button" class="safe" @click=${() => this.done(false)}>Cancel — keep the file</button>
            <button type="button" class="destroy" @click=${this.onDestroy}>${second ? req.secondConfirmLabel : req.confirmLabel}</button>
          </div>
        </div>
      </dialog>
    `;
  }
}

/**
 * Ask a destructive question, twice. Resolves true only if the user confirmed
 * both times.
 *
 * Every other answer — Cancel, Esc, the close-X, the backdrop — is false, and
 * false must always be safe at the call site: the guard treats anything that is
 * not an explicit double yes as "do not write".
 */
export async function dangerConfirm(req: DangerConfirmRequest): Promise<boolean> {
  const el = document.createElement('danger-confirm');
  document.body.append(el);
  try {
    return await el.ask(req);
  } finally {
    el.remove();
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'danger-confirm': DangerConfirm;
  }
}
