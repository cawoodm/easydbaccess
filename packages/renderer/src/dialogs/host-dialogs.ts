import { LitElement, css, html, nothing } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { ctrlEnterSubmits, dialogChromeStyles } from './dialog-chrome.js';
import { makeDialogDraggable } from './draggable.js';

interface AlertState {
  kind: 'alert';
  title: string;
  message: string;
  resolve: () => void;
}
interface PromptState {
  kind: 'prompt';
  title: string;
  message: string;
  value: string;
  resolve: (v: string | null) => void;
}
interface ChoiceState {
  kind: 'choice';
  title: string;
  message: string;
  options: string[];
  resolve: (v: string | null) => void;
}

type DialogState = AlertState | PromptState | ChoiceState | null;

/**
 * Singleton dialog host. Exposes alert / prompt / choice as Promise-returning
 * methods on a single instance discoverable via HostDialogs.instance. Plugins
 * reach this through api.ui.dialogs.*; chrome code can call it directly.
 *
 * Only one dialog is active at a time — calls made while another dialog is
 * open are queued.
 */
@customElement('host-dialogs')
export class HostDialogs extends LitElement {
  static instance: HostDialogs | null = null;

  static override styles = [
    dialogChromeStyles,
    css`
      dialog {
        min-width: 360px;
        max-width: 520px;
      }
      /* Shorter, looser body for the simple alert/prompt/choice modes. */
      .dialog-body {
        gap: 0.85rem;
      }
      p.message {
        margin: 0;
        color: #374151;
        white-space: pre-wrap;
        font-size: 0.95rem;
      }
      input[type='text'] {
        font: inherit;
        padding: 0.45rem 0.55rem;
        border: 1px solid #d1d5db;
        border-radius: 0.25rem;
        width: 100%;
        box-sizing: border-box;
      }
      .choices {
        display: flex;
        flex-direction: column;
        gap: 0.4rem;
      }
      button.choice {
        background: white;
        border: 1px solid #d1d5db;
        padding: 0.5rem 0.75rem;
        border-radius: 0.25rem;
        cursor: pointer;
        font: inherit;
        text-align: left;
      }
      button.choice:hover {
        background: #f3f4f6;
        border-color: #9ca3af;
      }
    `,
  ];

  @state() private current: DialogState = null;
  private queue: (() => void)[] = [];
  private dialogEl: HTMLDialogElement | null = null;

  override connectedCallback() {
    super.connectedCallback();
    HostDialogs.instance = this;
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    if (HostDialogs.instance === this) HostDialogs.instance = null;
  }

  override firstUpdated() {
    this.dialogEl = this.shadowRoot?.querySelector('dialog') ?? null;
  }

  override updated() {
    // Body re-renders each time `current` flips; the header inside is
    // recreated (different template per dialog kind), so re-call the helper
    // each show — it's idempotent on already-bound nodes via a WeakSet.
    if (!this.dialogEl) return;
    const header = this.shadowRoot?.querySelector('.dialog-header') as HTMLElement | null;
    if (header) makeDialogDraggable(this.dialogEl, header);
  }

  alert(message: string, title = 'Notice'): Promise<void> {
    return this.enqueue<void>((resolve) => {
      this.current = { kind: 'alert', title, message, resolve };
    });
  }

  async confirm(message: string, title = 'Confirm'): Promise<boolean> {
    const answer = await this.choice(message, ['Yes', 'No'], title);
    return answer === 'Yes';
  }

  prompt(message: string, defaultValue = '', title = 'Input'): Promise<string | null> {
    return this.enqueue<string | null>((resolve) => {
      this.current = {
        kind: 'prompt',
        title,
        message,
        value: defaultValue,
        resolve,
      };
    });
  }

  choice(message: string, options: string[], title = 'Choose'): Promise<string | null> {
    return this.enqueue<string | null>((resolve) => {
      this.current = { kind: 'choice', title, message, options, resolve };
    });
  }

  /** Open dialogs sequentially. */
  private enqueue<T>(setupCurrent: (resolve: (v: T) => void) => void): Promise<T> {
    return new Promise<T>((resolve) => {
      const start = () => {
        setupCurrent(resolve as (v: T) => void);
        this.updateComplete.then(() => this.dialogEl?.showModal());
      };
      if (this.current) this.queue.push(start);
      else start();
    });
  }

  private closeAndResolve(value: unknown) {
    const c = this.current;
    if (!c) return;
    this.dialogEl?.close();
    this.current = null;
    // Resolve after the close so any awaited code sees the dialog gone.
    queueMicrotask(() => {
      if (c.kind === 'alert') (c.resolve as () => void)();
      else (c.resolve as (v: unknown) => void)(value);
      const next = this.queue.shift();
      if (next) next();
    });
  }

  private onCancel = (e: Event) => {
    e.preventDefault();
    const c = this.current;
    if (!c) return;
    if (c.kind === 'alert') this.closeAndResolve(undefined);
    else this.closeAndResolve(null);
  };

  private submitPrompt = (e: Event) => {
    e.preventDefault();
    if (this.current?.kind !== 'prompt') return;
    this.closeAndResolve(this.current.value);
  };

  private submitAlert = (e: Event) => {
    e.preventDefault();
    this.closeAndResolve(undefined);
  };

  private cancelPrompt = () => this.closeAndResolve(null);

  /**
   * Close via the X is semantically the same as the dialog's cancel event:
   * alert resolves with undefined; prompt/choice resolve with null. We dispatch
   * a synthetic 'cancel' event so the existing onCancel logic decides.
   */
  private onCloseX = () => {
    if (this.dialogEl && !this.dialogEl.dispatchEvent(new Event('cancel', { cancelable: true }))) {
      // listener preventDefault'd — already handled
    } else {
      // Fallback: call onCancel directly.
      this.onCancel(new Event('cancel', { cancelable: true }));
    }
  };

  override render() {
    const c = this.current;
    return html`
      <dialog @cancel=${this.onCancel} @keydown=${ctrlEnterSubmits}>
        <button type="button" class="close-x" title="Close" @click=${this.onCloseX}>×</button>
        ${c ? this.renderBody(c) : nothing}
      </dialog>
    `;
  }

  private renderBody(c: NonNullable<DialogState>) {
    switch (c.kind) {
      case 'alert':
        // Wrapped in a form so the shared Ctrl+Enter helper can submit it
        // (calling closeAndResolve via the submit handler). The OK button
        // is the form's submit button.
        return html`
          <form @submit=${this.submitAlert}>
            <div class="dialog-header">
              <h2>${c.title}</h2>
              <div class="header-actions">
                <button type="submit" class="primary">OK</button>
              </div>
            </div>
            <div class="dialog-body">
              <p class="message">${c.message}</p>
            </div>
          </form>
        `;
      case 'prompt':
        return html`
          <form @submit=${this.submitPrompt}>
            <div class="dialog-header">
              <h2>${c.title}</h2>
              <div class="header-actions">
                <button type="button" class="ghost" @click=${this.cancelPrompt}>Cancel</button>
                <button type="submit" class="primary">OK</button>
              </div>
            </div>
            <div class="dialog-body">
              <p class="message">${c.message}</p>
              <input
                type="text"
                autofocus
                .value=${c.value}
                @input=${(e: Event) => {
                  if (this.current?.kind === 'prompt') {
                    this.current = { ...this.current, value: (e.target as HTMLInputElement).value };
                  }
                }}
              />
            </div>
          </form>
        `;
      case 'choice':
        // Choice options are themselves the actions, so they stay in the
        // body. The header keeps the consistent title bar + a Cancel so
        // the action area still lives at the top.
        return html`
          <div class="dialog-header">
            <h2>${c.title}</h2>
            <div class="header-actions">
              <button class="ghost" @click=${() => this.closeAndResolve(null)}>Cancel</button>
            </div>
          </div>
          <div class="dialog-body">
            ${c.message ? html`<p class="message">${c.message}</p>` : nothing}
            <div class="choices">
              ${c.options.map(
                (opt) =>
                  html`<button class="choice" @click=${() => this.closeAndResolve(opt)}>
                    ${opt}
                  </button>`,
              )}
            </div>
          </div>
        `;
    }
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'host-dialogs': HostDialogs;
  }
}
