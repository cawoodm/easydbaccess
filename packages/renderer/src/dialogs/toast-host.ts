import { LitElement, css, html } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { materialIconStyles } from '../chrome/material-icon-css.js';

export type ToastKind = 'info' | 'success' | 'error' | 'warning';

interface Toast {
  id: number;
  kind: ToastKind;
  title?: string;
  message: string;
  timer?: number;
}

/**
 * Non-modal toast queue. Stacks at top-center; auto-dismisses after 4s
 * (success/info) or 7s (warning/error). Reached via api.ui.dialogs.toast
 * (added in this commit) or ToastHost.instance.show(...).
 */
@customElement('toast-host')
export class ToastHost extends LitElement {
  static instance: ToastHost | null = null;

  static override styles = [
    materialIconStyles,
    css`
      :host {
        position: fixed;
        top: 56px;
        left: 50%;
        transform: translateX(-50%);
        z-index: 200000;
        display: flex;
        flex-direction: column;
        gap: 0.4rem;
        pointer-events: none;
        max-width: 90vw;
      }
      .toast {
        min-width: 260px;
        max-width: 480px;
        background: white;
        border-radius: 0.35rem;
        box-shadow: 0 10px 25px rgba(0, 0, 0, 0.18);
        padding: 0.55rem 0.75rem;
        display: grid;
        grid-template-columns: auto 1fr auto;
        gap: 0.55rem;
        align-items: center;
        pointer-events: auto;
        border-left: 4px solid #6b7280;
        animation: slide-in 160ms ease-out;
      }
      .toast.success {
        border-left-color: #16a34a;
      }
      .toast.error {
        border-left-color: #dc2626;
      }
      .toast.warning {
        border-left-color: #d97706;
      }
      .toast.info {
        border-left-color: #2563eb;
      }
      .toast .mi.lg {
        font-size: 1.4rem;
      }
      .toast.success .mi {
        color: #16a34a;
      }
      .toast.error .mi {
        color: #dc2626;
      }
      .toast.warning .mi {
        color: #d97706;
      }
      .toast.info .mi {
        color: #2563eb;
      }
      .body {
        line-height: 1.3;
        font-size: 0.9rem;
      }
      .body strong {
        display: block;
        font-size: 0.9rem;
        margin-bottom: 0.1rem;
      }
      button.close {
        background: transparent;
        border: 0;
        cursor: pointer;
        color: #6b7280;
        padding: 0 0.15rem;
        line-height: 1;
        font-size: 1rem;
      }
      button.close:hover {
        color: #111;
      }
      @keyframes slide-in {
        from {
          opacity: 0;
          transform: translateY(-8px);
        }
        to {
          opacity: 1;
          transform: translateY(0);
        }
      }
    `,
  ];

  @state() private toasts: Toast[] = [];
  private nextId = 1;

  override connectedCallback() {
    super.connectedCallback();
    ToastHost.instance = this;
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    if (ToastHost.instance === this) ToastHost.instance = null;
  }

  show(
    message: string,
    opts?: {
      kind?: ToastKind | undefined;
      title?: string | undefined;
      durationMs?: number | undefined;
    },
  ): void {
    const t: Toast = {
      id: this.nextId++,
      kind: opts?.kind ?? 'info',
      message,
      ...(opts?.title ? { title: opts.title } : {}),
    };
    this.toasts = [...this.toasts, t];
    const dur =
      opts?.durationMs ?? (t.kind === 'error' || t.kind === 'warning' ? 7000 : 4000);
    t.timer = window.setTimeout(() => this.dismiss(t.id), dur);
  }

  private dismiss(id: number) {
    const t = this.toasts.find((x) => x.id === id);
    if (t?.timer != null) window.clearTimeout(t.timer);
    this.toasts = this.toasts.filter((x) => x.id !== id);
  }

  override render() {
    return html`
      ${this.toasts.map(
        (t) => html`
          <div class="toast ${t.kind}" role="status">
            <span class="mi lg">${iconFor(t.kind)}</span>
            <span class="body">
              ${t.title ? html`<strong>${t.title}</strong>` : ''}${t.message}
            </span>
            <button class="close" title="Dismiss" @click=${() => this.dismiss(t.id)}>
              <span class="mi">close</span>
            </button>
          </div>
        `,
      )}
    `;
  }
}

function iconFor(k: ToastKind): string {
  switch (k) {
    case 'success':
      return 'check_circle';
    case 'error':
      return 'error';
    case 'warning':
      return 'warning';
    default:
      return 'info';
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'toast-host': ToastHost;
  }
}
