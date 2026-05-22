import { LitElement, css, html, nothing } from 'lit';
import { customElement, state } from 'lit/decorators.js';
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

  static override styles = css`
    :host {
      display: contents;
    }
    dialog {
      border: 0;
      border-radius: 0.5rem;
      padding: 0;
      min-width: 360px;
      max-width: 520px;
      box-shadow: 0 20px 50px rgba(0, 0, 0, 0.25);
      font-family: system-ui, sans-serif;
    }
    dialog::backdrop {
      background: rgba(15, 23, 42, 0.4);
    }
    .body {
      padding: 1.1rem 1.25rem;
      display: flex;
      flex-direction: column;
      gap: 0.85rem;
    }
    h2 {
      margin: 0;
      font-size: 1.05rem;
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
    .actions {
      display: flex;
      justify-content: flex-end;
      gap: 0.5rem;
      border-top: 1px solid #e5e7eb;
      padding: 0.75rem 1.25rem;
      background: #f9fafb;
      border-radius: 0 0 0.5rem 0.5rem;
    }
    .choices {
      display: flex;
      flex-direction: column;
      gap: 0.4rem;
      padding: 0.75rem 1.25rem 1rem;
    }
    button.primary {
      background: #3b82f6;
      color: white;
      border: 0;
      padding: 0.45rem 0.9rem;
      border-radius: 0.25rem;
      cursor: pointer;
      font: inherit;
    }
    button.primary:hover {
      background: #2563eb;
    }
    button.ghost {
      background: transparent;
      border: 1px solid #d1d5db;
      padding: 0.45rem 0.9rem;
      border-radius: 0.25rem;
      cursor: pointer;
      font: inherit;
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
  `;

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
    // Body re-renders each time `current` flips; the h2 inside is recreated,
    // so we need to re-bind the drag handle each show.
    if (!this.dialogEl) return;
    const h2 = this.shadowRoot?.querySelector('h2') as HTMLElement | null;
    if (h2) makeDialogDraggable(this.dialogEl, h2);
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

  private cancelPrompt = () => this.closeAndResolve(null);

  override render() {
    const c = this.current;
    return html`
      <dialog @cancel=${this.onCancel}>
        ${c ? this.renderBody(c) : nothing}
      </dialog>
    `;
  }

  private renderBody(c: NonNullable<DialogState>) {
    switch (c.kind) {
      case 'alert':
        return html`
          <div class="body">
            <h2>${c.title}</h2>
            <p class="message">${c.message}</p>
          </div>
          <div class="actions">
            <button class="primary" @click=${() => this.closeAndResolve(undefined)}>OK</button>
          </div>
        `;
      case 'prompt':
        return html`
          <form @submit=${this.submitPrompt}>
            <div class="body">
              <h2>${c.title}</h2>
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
            <div class="actions">
              <button type="button" class="ghost" @click=${this.cancelPrompt}>Cancel</button>
              <button type="submit" class="primary">OK</button>
            </div>
          </form>
        `;
      case 'choice':
        return html`
          <div class="body">
            <h2>${c.title}</h2>
            ${c.message ? html`<p class="message">${c.message}</p>` : nothing}
          </div>
          <div class="choices">
            ${c.options.map(
              (opt) =>
                html`<button class="choice" @click=${() => this.closeAndResolve(opt)}>
                  ${opt}
                </button>`,
            )}
            <button class="ghost" @click=${() => this.closeAndResolve(null)}>Cancel</button>
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
