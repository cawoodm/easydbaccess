import { LitElement, css, html } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { makeDialogDraggable } from './draggable.js';

/**
 * Modal editor for a column's `script` source — the JS body used by the
 * built-in `script` cell renderer. Mounted once from `<app-shell>` and
 * accessed via the static `instance` accessor (same pattern as
 * `HostDialogs.instance`). `open()` returns a promise that resolves to
 * the new source on Save or `null` on Cancel.
 *
 * The textarea is the entire editing surface — deliberately plain to
 * stay inside the renderer bundle without pulling in a code editor
 * dependency. Power users who want full IntelliSense can paste from
 * their own editor.
 */
@customElement('script-editor-dialog')
export class ScriptEditorDialog extends LitElement {
  static instance: ScriptEditorDialog | null = null;

  static override styles = css`
    :host {
      display: contents;
    }
    dialog {
      position: relative;
      border: 0;
      border-radius: 0.5rem;
      padding: 0;
      width: 720px;
      max-width: 92vw;
      box-shadow: 0 20px 50px rgba(0, 0, 0, 0.25);
      font-family: system-ui, sans-serif;
    }
    button.close-x {
      position: absolute;
      top: 0.55rem;
      right: 0.6rem;
      background: transparent;
      border: 0;
      cursor: pointer;
      color: #9ca3af;
      font-size: 1.1rem;
      padding: 0.15rem 0.3rem;
      line-height: 1;
      border-radius: 0.2rem;
    }
    button.close-x:hover {
      color: #111;
      background: #f3f4f6;
    }
    dialog::backdrop {
      background: rgba(15, 23, 42, 0.4);
    }
    form {
      padding: 1.1rem 1.25rem;
      display: flex;
      flex-direction: column;
      gap: 0.75rem;
    }
    h2 {
      margin: 0;
      font-size: 1.05rem;
    }
    p.hint {
      margin: 0;
      color: #6b7280;
      font-size: 0.85rem;
    }
    p.hint code {
      font-family: ui-monospace, SFMono-Regular, monospace;
      background: #f3f4f6;
      padding: 0.05rem 0.25rem;
      border-radius: 0.2rem;
    }
    textarea {
      font: 0.85rem ui-monospace, SFMono-Regular, monospace;
      padding: 0.6rem 0.75rem;
      border: 1px solid #d1d5db;
      border-radius: 0.25rem;
      min-height: 320px;
      resize: vertical;
      tab-size: 2;
    }
    .actions {
      display: flex;
      justify-content: flex-end;
      gap: 0.5rem;
      border-top: 1px solid #e5e7eb;
      padding: 0.7rem 1.25rem;
      background: #f9fafb;
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
  `;

  @state() private text = '';
  @state() private columnLabel = '';
  private dialogEl: HTMLDialogElement | null = null;
  private resolver: ((v: string | null) => void) | null = null;

  override connectedCallback() {
    super.connectedCallback();
    ScriptEditorDialog.instance = this;
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    if (ScriptEditorDialog.instance === this) ScriptEditorDialog.instance = null;
  }

  override firstUpdated() {
    this.dialogEl = this.shadowRoot?.querySelector('dialog') ?? null;
    const h2 = this.shadowRoot?.querySelector('h2') as HTMLElement | null;
    if (this.dialogEl && h2) makeDialogDraggable(this.dialogEl, h2);
  }

  /**
   * Open the editor with the given source and column label. Resolves to
   * the new source on Save, or `null` if the user cancels / dismisses.
   * Only one editor instance is active at a time; calling open() again
   * before the previous promise resolves will cancel the previous one.
   */
  async open(initial: string, columnLabel: string): Promise<string | null> {
    if (this.resolver) {
      // Caller opened a new editor before resolving the previous one —
      // treat the old promise as cancelled so it doesn't hang.
      this.resolver(null);
      this.resolver = null;
    }
    this.text = initial ?? '';
    this.columnLabel = columnLabel ?? '';
    await this.updateComplete;
    this.dialogEl?.showModal();
    return new Promise((resolve) => {
      this.resolver = resolve;
    });
  }

  private resolve(value: string | null) {
    const r = this.resolver;
    this.resolver = null;
    this.dialogEl?.close();
    if (r) r(value);
  }

  private onCancel = () => this.resolve(null);

  private onSubmit = (e: Event) => {
    e.preventDefault();
    this.resolve(this.text);
  };

  override render() {
    return html`
      <dialog @cancel=${this.onCancel}>
        <button type="button" class="close-x" title="Close" @click=${this.onCancel}>×</button>
        <form @submit=${this.onSubmit}>
          <h2>Edit script${this.columnLabel ? ` — ${this.columnLabel}` : ''}</h2>
          <p class="hint">
            Define <code>function render(row) { … }</code>. <code>row</code> is
            the full row object; return an HTML string. Throws or non-string
            returns show a small error chip in the cell.
          </p>
          <textarea
            spellcheck="false"
            autofocus
            .value=${this.text}
            @input=${(e: Event) => (this.text = (e.target as HTMLTextAreaElement).value)}
          ></textarea>
          <div class="actions">
            <button type="button" class="ghost" @click=${this.onCancel}>Cancel</button>
            <button type="submit" class="primary">Save</button>
          </div>
        </form>
      </dialog>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'script-editor-dialog': ScriptEditorDialog;
  }
}
