// packages/renderer/src/dialogs/commandlet-dialog.ts
//
// "Run commandlet" — a text box that tells you whether what you are typing will
// work, before you run it. Lazy-loaded from the `commandlets` plugin.
//
// The check is the same parse and the same lookups the runner does
// (`checkCommandletString`), so "valid" here means valid there — not a
// re-implementation that can drift from it.

import { LitElement, css, html, nothing } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { ctrlEnterSubmits, dialogChromeStyles } from './dialog-chrome.js';
import { makeDialogDraggable } from './draggable.js';
import { watchDialogDirty } from '../chrome/dirty-guard.js';

/** The user guide, on GitHub so the link works from a packaged build too. */
export const COMMANDLET_HELP_URL = 'https://github.com/cawoodm/easydbaccess/blob/main/docs/help/commandlets.md';

export type CommandletChecker = (input: string) => Promise<{ ok: boolean; message: string }>;

let singleton: CommandletDialog | null = null;
function host(): CommandletDialog {
  if (!singleton) {
    singleton = document.createElement('commandlet-dialog') as CommandletDialog;
    document.body.appendChild(singleton);
  }
  return singleton;
}

@customElement('commandlet-dialog')
export class CommandletDialog extends LitElement {
  /** Resolves to the commandlet to run, or null if the user backed out. */
  static open(check: CommandletChecker, initial = ''): Promise<string | null> {
    return host().openDialog(check, initial);
  }

  static override styles = [
    dialogChromeStyles,
    css`
      dialog {
        min-width: 460px;
        max-width: 620px;
      }
      input.commandlet {
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        font-size: 0.9rem;
        padding: 0.5rem 0.6rem;
        border: 1px solid #d1d5db;
        border-radius: 0.25rem;
        width: 100%;
        box-sizing: border-box;
      }
      input.commandlet:focus {
        outline: 2px solid #3b82f6;
        outline-offset: -1px;
      }
      /* The verdict line keeps its height whatever it says, so the dialog does
         not jump around while the user types. */
      .verdict {
        min-height: 1.4rem;
        font-size: 0.85rem;
        line-height: 1.4;
        display: flex;
        gap: 0.4rem;
        align-items: baseline;
      }
      .verdict.ok {
        color: #047857;
      }
      .verdict.bad {
        color: #b91c1c;
      }
      .verdict .mark {
        font-weight: 700;
      }
      .hint {
        margin: 0;
        font-size: 0.82rem;
        color: #6b7280;
        line-height: 1.5;
      }
      .hint code {
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        background: #f3f4f6;
        padding: 0.05rem 0.25rem;
        border-radius: 0.2rem;
      }
      a.help {
        display: inline-grid;
        place-items: center;
        width: 1.3rem;
        height: 1.3rem;
        border-radius: 50%;
        border: 1px solid #6b7280;
        color: #e5e7eb;
        text-decoration: none;
        font-size: 0.8rem;
        font-weight: 700;
        line-height: 1;
      }
      a.help:hover {
        background: rgba(255, 255, 255, 0.12);
        color: white;
        border-color: #9ca3af;
      }
    `,
  ];

  @state() private value = '';
  @state() private verdict: { ok: boolean; message: string } | null = null;

  private check: CommandletChecker | null = null;
  private checkSeq = 0;
  private dialogEl: HTMLDialogElement | null = null;
  private resolveFn: ((v: string | null) => void) | null = null;

  override firstUpdated(): void {
    this.dialogEl = this.shadowRoot?.querySelector('dialog') ?? null;
    const header = this.shadowRoot?.querySelector('.dialog-header') as HTMLElement | null;
    if (this.dialogEl && header) makeDialogDraggable(this.dialogEl, header);
    if (this.dialogEl) watchDialogDirty('commandlet', this.dialogEl);
  }

  private openDialog(check: CommandletChecker, initial: string): Promise<string | null> {
    this.check = check;
    this.value = initial;
    this.verdict = null;
    if (initial) void this.revalidate();
    return new Promise<string | null>((resolve) => {
      this.resolveFn = resolve;
      void this.updateComplete.then(() => {
        this.dialogEl?.showModal();
        const input = this.shadowRoot?.querySelector('input.commandlet') as HTMLInputElement | null;
        input?.focus();
        input?.select();
      });
    });
  }

  /**
   * Re-check on every keystroke. Answers are sequence-stamped and a late one is
   * dropped: the check hits the store, so a slow reply for "goto/bi" must not
   * overwrite the verdict for "goto/bible".
   */
  private async revalidate(): Promise<void> {
    const seq = ++this.checkSeq;
    const text = this.value.trim();
    if (!text || !this.check) {
      this.verdict = null;
      return;
    }
    const result = await this.check(text);
    if (seq === this.checkSeq) this.verdict = result;
  }

  private onInput = (e: Event): void => {
    this.value = (e.target as HTMLInputElement).value;
    void this.revalidate();
  };

  private finish(value: string | null): void {
    this.dialogEl?.close();
    const resolve = this.resolveFn;
    this.resolveFn = null;
    queueMicrotask(() => resolve?.(value));
  }

  private onSubmit = (e: Event): void => {
    e.preventDefault();
    const text = this.value.trim();
    // A commandlet that will not work is not run: the verdict already says why,
    // and an error toast a moment later would only repeat it.
    if (!text || this.verdict?.ok === false) return;
    this.finish(text);
  };

  private onCancel = (e: Event): void => {
    e.preventDefault();
    this.finish(null);
  };

  override render() {
    const v = this.verdict;
    return html`
      <dialog @cancel=${this.onCancel} @keydown=${ctrlEnterSubmits}>
        <button type="button" class="close-x" title="Close" @click=${() => this.finish(null)}>×</button>
        <form @submit=${this.onSubmit}>
          <div class="dialog-header">
            <h2>Run commandlet</h2>
            <div class="header-actions">
              <a class="help" href=${COMMANDLET_HELP_URL} target="_blank" rel="noopener noreferrer" title="What is a commandlet?">?</a>
              <button type="button" class="ghost" @click=${() => this.finish(null)}>Cancel</button>
              <button type="submit" class="primary" ?disabled=${v?.ok === false || this.value.trim() === ''}>Run</button>
            </div>
          </div>
          <div class="dialog-body">
            <input class="commandlet" type="text" spellcheck="false" placeholder="goto/bible?Book=Matthew" .value=${this.value} @input=${this.onInput} />
            <div class="verdict ${v ? (v.ok ? 'ok' : 'bad') : ''}">${v ? html`<span class="mark">${v.ok ? '✓' : '✕'}</span><span>${v.message}</span>` : nothing}</div>
            <p class="hint">
              <code>goto/&lt;table&gt;?&lt;Column&gt;=&lt;filter&gt;</code> — add <code>@sort=-Field</code>, <code>@search=…</code> or <code>@clear=1</code>; chain with <code>;</code>. Also
              <code>search/…</code>, <code>view/…</code> and <code>cmd/&lt;id&gt;</code>.
            </p>
          </div>
        </form>
      </dialog>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'commandlet-dialog': CommandletDialog;
  }
}
