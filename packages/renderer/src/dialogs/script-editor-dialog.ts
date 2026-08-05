import { LitElement, css, html } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { ctrlEnterSubmits, dialogChromeStyles } from './dialog-chrome.js';
import { makeDialogDraggable } from './draggable.js';
import { RENDER_SAMPLES, VALIDATE_SAMPLES, type ScriptSample } from './script-samples.js';

/**
 * Which of a column's two scripts is being edited. They share this one editor
 * because everything around the textarea — draggable modal, Ctrl-Enter save,
 * cancel semantics — is identical; only the boilerplate, the wording and the
 * samples dropdown differ.
 */
export type ScriptKind = 'render' | 'validate';

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
 * The same for a validation script. Deliberately a rule that never fires: the
 * shape is the lesson, and a fresh column shouldn't start rejecting edits just
 * because the editor was opened and saved.
 */
const VALIDATE_BOILERPLATE = `function validate(value, row) {
  // \`value\` is what the user just typed; \`row\` is the rest of the row.
  // THROW to reject the edit — the message is what they will see.
  if (false) throw new Error('Explain what is wrong here.');
}
`;

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
      .samples {
        display: flex;
        align-items: center;
        gap: 0.5rem;
        font-size: 0.85rem;
        color: #374151;
      }
      .samples select {
        font: inherit;
        padding: 0.3rem 0.4rem;
        border: 1px solid #d1d5db;
        border-radius: 0.25rem;
        flex: 1;
        min-width: 0;
      }
      button.link {
        background: transparent;
        border: 0;
        padding: 0;
        color: #2563eb;
        font: inherit;
        text-decoration: underline;
        cursor: pointer;
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
  @state() private kind: ScriptKind = 'render';
  /**
   * What the editor held before a sample was applied, so one dropdown pick
   * can't silently eat a hand-written rule. Cleared once the user types (they
   * are now editing the sample, not deciding whether to keep it) and on every
   * open.
   */
  @state() private undoText: string | null = null;
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
   */
  async open(initial: string, columnLabel: string, kind: ScriptKind = 'render'): Promise<string | null> {
    if (this.resolver) {
      // Caller opened a new editor before resolving the previous one —
      // treat the old promise as cancelled so it doesn't hang.
      this.resolver(null);
      this.resolver = null;
    }
    this.kind = kind;
    this.undoText = null;
    // Pre-fill with boilerplate so users opening a fresh column-script see
    // the expected shape instead of an intimidating empty textarea. An
    // existing script wins — we never overwrite the user's source.
    this.text = initial && initial.trim() ? initial : kind === 'validate' ? VALIDATE_BOILERPLATE : BOILERPLATE;
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

  /** The sample list for whichever script is being edited. */
  private get samples(): ReadonlyArray<ScriptSample> {
    return this.kind === 'validate' ? VALIDATE_SAMPLES : RENDER_SAMPLES;
  }

  /**
   * Replace the editor contents with a sample, remembering what was there. The
   * `<select>` is reset to its placeholder so picking the SAME sample again
   * (after an undo, say) still fires a change event.
   */
  private applySample(e: Event) {
    const select = e.target as HTMLSelectElement;
    const sample = this.samples[Number(select.value)];
    select.value = '';
    if (!sample) return;
    this.undoText = this.text;
    this.text = sample.source;
  }

  private undoSample() {
    if (this.undoText === null) return;
    this.text = this.undoText;
    this.undoText = null;
  }

  private onInput(e: Event) {
    this.text = (e.target as HTMLTextAreaElement).value;
    // They're editing the sample now, not still deciding about it.
    this.undoText = null;
  }

  /** The explanation above the textarea — different job, different contract. */
  private renderHints() {
    if (this.kind === 'validate') {
      return html`
        <p class="hint">
          Define <code>function validate(value, row) { … }</code>. It runs when someone edits a cell in this column by hand, after the Max / Unique / Not-null boxes have had their say.
          <strong>Throw to reject the edit</strong> — your message is what they are shown, and the cell snaps back. Return without throwing to accept it; the return value is ignored.
        </p>
        <p class="hint">
          <code>value</code> is the proposed new value, <code>row</code> the rest of the row, so a rule can compare columns. Imports, refreshes and sync are not edits and never run it.
        </p>
      `;
    }
    return html`
      <p class="hint">
        Define <code>function render(row) { … }</code>. <code>row</code> is the full row object. What you return is passed to the column's renderer, so the cell shows a computed value instead of the
        stored one — and the cell becomes read-only. A script that throws shows a small error chip in the cell.
      </p>
      <p class="hint">
        Besides the JS globals you can call <code>markdownToHtml(text)</code> (also <code>easydb.markdownToHtml</code>) — set this column's renderer to <code>html</code> so the result shows as
        formatted text rather than as its own source. A sample that needs a particular renderer says so in its first line; the dropdown can't set it for you.
      </p>
    `;
  }

  override render() {
    const validating = this.kind === 'validate';
    return html`
      <dialog @cancel=${this.onCancel} @keydown=${ctrlEnterSubmits}>
        <button type="button" class="close-x" title="Close" @click=${this.onCancel}>×</button>
        <form @submit=${this.onSubmit}>
          <div class="dialog-header">
            <h2>${validating ? 'Edit validation' : 'Edit script'}${this.columnLabel ? ` — ${this.columnLabel}` : ''}</h2>
            <div class="header-actions">
              <button type="button" class="ghost" @click=${this.onCancel}>Cancel</button>
              <button type="submit" class="primary">Save</button>
            </div>
          </div>
          <div class="dialog-body">
            ${this.renderHints()}
            <div class="samples">
              <label for="sample">Start from a sample</label>
              <select
                id="sample"
                title=${validating ? 'Replace the editor contents with a ready-made rule' : 'Replace the editor contents with a ready-made script'}
                @change=${(e: Event) => this.applySample(e)}
              >
                <option value="">— choose —</option>
                ${this.samples.map((s, i) => html`<option value=${i}>${s.label}</option>`)}
              </select>
              ${this.undoText !== null ? html`<button type="button" class="link" @click=${() => this.undoSample()}>Undo</button>` : null}
            </div>
            <textarea spellcheck="false" autofocus .value=${this.text} @input=${(e: Event) => this.onInput(e)}></textarea>
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
