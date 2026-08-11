// packages/renderer/src/dialogs/tips-dialog.ts
//
// The startup "Tip" dialog: one tip at a time with ‹ › to walk the list, a
// "Don't show again" checkbox and OK. Lazy-loaded via dynamic import() from the
// `tips` plugin so it never registers its custom element on a boot where every
// tip has already been seen.

import { LitElement, css, html } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { ctrlEnterSubmits, dialogChromeStyles, makeDialogDraggable } from '@cawoodm/lit-dialogs';

export interface TipsDialogTip {
  id: string;
  text: string;
}

export interface TipsDialogInput {
  tips: TipsDialogTip[];
  /** Index of the tip to open on — the first the user has not seen. */
  startIndex: number;
}

export interface TipsDialogResult {
  /** User asked not to see tips again — the caller disables the plugin. */
  dontShowAgain: boolean;
  /** Ids of every tip actually shown, so the caller can mark them seen. */
  viewed: string[];
}

/** The lightbulb shown beside every tip. One icon for all tips, by design. */
const TIP_ICON = html`
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M9 18h6" />
    <path d="M10 21h4" />
    <path d="M12 2a7 7 0 0 0-4 12.7c.6.5 1 1.2 1 2V15h6v-.3c0-.8.4-1.5 1-2A7 7 0 0 0 12 2z" />
  </svg>
`;

let singleton: TipsDialog | null = null;
function host(): TipsDialog {
  if (!singleton) {
    singleton = document.createElement('tips-dialog') as TipsDialog;
    document.body.appendChild(singleton);
  }
  return singleton;
}

@customElement('tips-dialog')
export class TipsDialog extends LitElement {
  /** Self-mounting singleton — the caller doesn't need to place the element. */
  static open(input: TipsDialogInput): Promise<TipsDialogResult> {
    return host().openDialog(input);
  }

  static override styles = [
    dialogChromeStyles,
    css`
      dialog {
        min-width: 420px;
        max-width: 540px;
      }
      .dialog-body {
        gap: 1.15rem;
      }
      .tip-card {
        display: flex;
        gap: 0.9rem;
        align-items: flex-start;
        background: linear-gradient(180deg, #f8fafc, #f1f5f9);
        border: 1px solid #e2e8f0;
        border-radius: 0.5rem;
        padding: 1rem 1.1rem;
      }
      .tip-icon {
        flex: 0 0 auto;
        display: grid;
        place-items: center;
        width: 2.4rem;
        height: 2.4rem;
        border-radius: 50%;
        background: #dbeafe;
        color: #1d4ed8;
      }
      .tip-icon svg {
        width: 1.35rem;
        height: 1.35rem;
      }
      p.tip {
        margin: 0;
        align-self: center;
        font-size: 1.02rem;
        line-height: 1.55;
        color: #0f172a;
      }
      .nav {
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 0.9rem;
      }
      button.nav-btn {
        display: grid;
        place-items: center;
        width: 2rem;
        height: 2rem;
        padding: 0;
        border: 1px solid #d1d5db;
        border-radius: 50%;
        background: white;
        color: #334155;
        cursor: pointer;
      }
      button.nav-btn:hover:not(:disabled) {
        background: #f1f5f9;
        border-color: #94a3b8;
      }
      button.nav-btn:disabled {
        opacity: 0.35;
        cursor: default;
      }
      button.nav-btn svg {
        width: 1rem;
        height: 1rem;
      }
      p.counter {
        margin: 0;
        min-width: 6.5rem;
        text-align: center;
        font-size: 0.8rem;
        letter-spacing: 0.02em;
        color: #64748b;
      }
      label.dont-show {
        display: flex;
        align-items: center;
        gap: 0.45rem;
        font-size: 0.86rem;
        color: #475569;
        cursor: pointer;
        border-top: 1px solid #e2e8f0;
        padding-top: 0.9rem;
      }
    `,
  ];

  @state() private tips: TipsDialogTip[] = [];
  @state() private index = 0;
  @state() private dontShowAgain = false;

  private viewed = new Set<string>();
  private dialogEl: HTMLDialogElement | null = null;
  private resolveFn: ((result: TipsDialogResult) => void) | null = null;

  override firstUpdated(): void {
    this.dialogEl = this.shadowRoot?.querySelector('dialog') ?? null;
    const header = this.shadowRoot?.querySelector('.dialog-header') as HTMLElement | null;
    if (this.dialogEl && header) makeDialogDraggable(this.dialogEl, header);
  }

  private openDialog(input: TipsDialogInput): Promise<TipsDialogResult> {
    this.tips = input.tips;
    this.index = input.startIndex;
    this.dontShowAgain = false;
    this.viewed = new Set();
    this.markViewed();
    return new Promise<TipsDialogResult>((resolve) => {
      this.resolveFn = resolve;
      void this.updateComplete.then(() => this.dialogEl?.showModal());
    });
  }

  /** Every tip the user actually lands on counts as seen, browsed or not. */
  private markViewed(): void {
    const tip = this.tips[this.index];
    if (tip) this.viewed.add(tip.id);
  }

  private step(delta: number): void {
    const next = this.index + delta;
    if (next < 0 || next >= this.tips.length) return;
    this.index = next;
    this.markViewed();
  }

  /**
   * Every exit — OK, Escape, the close X — returns the checkbox as it stands.
   * Ticking the box and then pressing Escape still means "stop showing tips".
   */
  private finish(): void {
    this.dialogEl?.close();
    const resolve = this.resolveFn;
    this.resolveFn = null;
    const result: TipsDialogResult = {
      dontShowAgain: this.dontShowAgain,
      viewed: [...this.viewed],
    };
    queueMicrotask(() => resolve?.(result));
  }

  private onCancel = (e: Event): void => {
    e.preventDefault();
    this.finish();
  };

  /** ← / → walk the tips, so the dialog is usable without the mouse. */
  private onKeydown = (e: KeyboardEvent): void => {
    if (e.key === 'ArrowLeft') this.step(-1);
    else if (e.key === 'ArrowRight') this.step(1);
    else return;
    e.preventDefault();
  };

  override render() {
    const tip = this.tips[this.index];
    return html`
      <dialog
        @cancel=${this.onCancel}
        @keydown=${(e: KeyboardEvent) => {
          ctrlEnterSubmits(e);
          this.onKeydown(e);
        }}
      >
        <button type="button" class="close-x" title="Close" @click=${() => this.finish()}>×</button>
        <form
          @submit=${(e: Event) => {
            e.preventDefault();
            this.finish();
          }}
        >
          <div class="dialog-header">
            <h2>Tip</h2>
            <div class="header-actions">
              <button type="submit" class="primary" autofocus>OK</button>
            </div>
          </div>
          <div class="dialog-body">
            <div class="tip-card">
              <span class="tip-icon">${TIP_ICON}</span>
              <p class="tip">${tip?.text ?? ''}</p>
            </div>
            <div class="nav">
              <button type="button" class="nav-btn prev" title="Previous tip" aria-label="Previous tip" ?disabled=${this.index === 0} @click=${() => this.step(-1)}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 6 9 12 15 18" /></svg>
              </button>
              <p class="counter">Tip ${this.index + 1} of ${this.tips.length}</p>
              <button type="button" class="nav-btn next" title="Next tip" aria-label="Next tip" ?disabled=${this.index >= this.tips.length - 1} @click=${() => this.step(1)}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 6 15 12 9 18" /></svg>
              </button>
            </div>
            <label class="dont-show">
              <input
                type="checkbox"
                .checked=${this.dontShowAgain}
                @change=${(e: Event) => {
                  this.dontShowAgain = (e.target as HTMLInputElement).checked;
                }}
              />
              Don't show again
            </label>
          </div>
        </form>
      </dialog>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'tips-dialog': TipsDialog;
  }
}
