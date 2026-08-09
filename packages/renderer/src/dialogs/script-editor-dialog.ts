import { LitElement, css, html } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { ctrlEnterSubmits, dialogChromeStyles } from './dialog-chrome.js';
import { makeDialogDraggable } from './draggable.js';

/**
 * Boilerplate inserted into a fresh script editor. Shows the required
 * `render(row)` signature and a minimal working example, so the user can hit
 * Save once and see the cell render without writing anything themselves.
 *
 * The return value replaces the stored value on its way into whatever
 * renderer the column has (or is shown as text when the column has none).
 */
const BOILERPLATE = `function render(row) {
  // \`row\` is the full row object — access any field by name (row.field).
  // Return the value this column should display.
  return row.name ?? '';
}
`;

/**
 * The same boilerplate for a VIEW TOKEN's script, seeded with the field the
 * token maps to (if it maps to one) — the transform the user wants is almost
 * always "that cell, formatted", so naming the field saves them looking it up.
 */
function tokenBoilerplate(field: string): string {
  const read = field ? `row.${field}` : 'row.name';
  return `function render(row) {
  // \`row\` is the full row object — access any field by name (row.field).
  // Return what this token should show; HTML is rendered, not escaped.
  return ${read} ?? '';
}
`;
}

/** Which kind of script is being edited — it changes the hints, not the shape. */
export type ScriptEditorVariant = 'column' | 'token';

/**
 * Modal editor for a column's `script` source. Mounted once from `<app-shell>` and
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

  static override styles = [
    dialogChromeStyles,
    css`
      dialog {
        width: 720px;
        max-width: 92vw;
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
        font:
          0.85rem ui-monospace,
          SFMono-Regular,
          monospace;
        padding: 0.6rem 0.75rem;
        border: 1px solid #d1d5db;
        border-radius: 0.25rem;
        min-height: 320px;
        resize: vertical;
        tab-size: 2;
      }
    `,
  ];

  @state() private text = '';
  @state() private columnLabel = '';
  @state() private variant: ScriptEditorVariant = 'column';
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
    const header = this.shadowRoot?.querySelector('.dialog-header') as HTMLElement | null;
    if (this.dialogEl && header) makeDialogDraggable(this.dialogEl, header);
  }

  /**
   * Open the editor with the given source and column label. Resolves to
   * the new source on Save, or `null` if the user cancels / dismisses.
   * Only one editor instance is active at a time; calling open() again
   * before the previous promise resolves will cancel the previous one.
   *
   * `opts.variant: 'token'` edits a VIEW TOKEN's script instead of a column's:
   * the shape is identical, so only the hints and the boilerplate change.
   * `opts.field` is the column that token maps to, used in the boilerplate.
   */
  async open(initial: string, columnLabel: string, opts?: { variant?: ScriptEditorVariant; field?: string }): Promise<string | null> {
    if (this.resolver) {
      // Caller opened a new editor before resolving the previous one —
      // treat the old promise as cancelled so it doesn't hang.
      this.resolver(null);
      this.resolver = null;
    }
    this.variant = opts?.variant ?? 'column';
    // Pre-fill with boilerplate so users opening a fresh column-script see
    // the expected shape instead of an intimidating empty textarea. An
    // existing script wins — we never overwrite the user's source.
    const blank = this.variant === 'token' ? tokenBoilerplate(opts?.field ?? '') : BOILERPLATE;
    this.text = initial && initial.trim() ? initial : blank;
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
      <dialog @cancel=${this.onCancel} @keydown=${ctrlEnterSubmits}>
        <button type="button" class="close-x" title="Close" @click=${this.onCancel}>×</button>
        <form @submit=${this.onSubmit}>
          <div class="dialog-header">
            <h2>Edit script${this.columnLabel ? ` — ${this.columnLabel}` : ''}</h2>
            <div class="header-actions">
              <button type="button" class="ghost" @click=${this.onCancel}>Cancel</button>
              <button type="submit" class="primary">Save</button>
            </div>
          </div>
          <div class="dialog-body">
            ${this.variant === 'token'
              ? html`<p class="hint">
                    Define <code>function render(row) { … }</code>. <code>row</code> is the full row object. What you return is what this token shows — the stored cell is never changed. The result
                    goes into the template as HTML, so <code>markdownToHtml(row.body)</code> shows formatted text and <code>new Date(row.date).toLocaleString()</code> shows a local date.
                  </p>
                  <p class="hint">
                    Only a plain <code>$TOKEN</code> runs the script. <code>$input.TOKEN</code> and <code>$filter.TOKEN</code> keep reading the mapped column, because one writes the cell back and the
                    other must match the stored value. A scripted token needs no column at all.
                  </p>`
              : html`<p class="hint">
                    Define <code>function render(row) { … }</code>. <code>row</code> is the full row object. What you return is passed to the column's renderer, so the cell shows a computed value
                    instead of the stored one — and the cell becomes read-only. A script that throws shows a small error chip in the cell.
                  </p>
                  <p class="hint">
                    Besides the JS globals you can call <code>markdownToHtml(text)</code> (also <code>easydb.markdownToHtml</code>) — set this column's renderer to <code>html</code> so the result
                    shows as formatted text rather than as its own source.
                  </p>`}
            <textarea spellcheck="false" autofocus .value=${this.text} @input=${(e: Event) => (this.text = (e.target as HTMLTextAreaElement).value)}></textarea>
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
