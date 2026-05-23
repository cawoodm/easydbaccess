import { LitElement, css, html } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { getContext } from '../app-context.js';
import { parseCsv } from '../plugins/csv-import.js';
import { makeDialogDraggable } from './draggable.js';

/**
 * Paste-CSV modal. Lets users drop CSV text into a textarea without dragging
 * a file — useful for spreadsheet copies, terminal output, etc. Uses the
 * same parser the drag-drop path does so behavior is identical.
 */
@customElement('csv-paste-dialog')
export class CsvPasteDialog extends LitElement {
  static override styles = css`
    :host {
      display: contents;
    }
    dialog {
      position: relative;
      border: 0;
      border-radius: 0.5rem;
      padding: 0;
      width: 640px;
      max-width: 90vw;
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
    label {
      display: flex;
      flex-direction: column;
      gap: 0.3rem;
      font-size: 0.85rem;
      color: #374151;
    }
    input[type='text'] {
      font: inherit;
      padding: 0.4rem 0.5rem;
      border: 1px solid #d1d5db;
      border-radius: 0.25rem;
    }
    textarea {
      font: 0.85rem ui-monospace, SFMono-Regular, monospace;
      padding: 0.5rem;
      border: 1px solid #d1d5db;
      border-radius: 0.25rem;
      min-height: 240px;
      resize: vertical;
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
    .error {
      color: #ef4444;
      font-size: 0.85rem;
    }
  `;

  @state() private name = '';
  @state() private text = '';
  @state() private errorMsg = '';
  private dialogEl: HTMLDialogElement | null = null;

  override firstUpdated() {
    this.dialogEl = this.shadowRoot?.querySelector('dialog') ?? null;
    const h2 = this.shadowRoot?.querySelector('h2') as HTMLElement | null;
    if (this.dialogEl && h2) makeDialogDraggable(this.dialogEl, h2);
  }

  async open(): Promise<void> {
    this.name = '';
    this.text = '';
    this.errorMsg = '';
    await this.updateComplete;
    this.dialogEl?.showModal();
  }

  private close() {
    this.dialogEl?.close();
  }

  private async submit(e: Event) {
    e.preventDefault();
    const name = this.name.trim() || 'pasted';
    if (this.text.trim().length === 0) {
      this.errorMsg = 'Paste some CSV first.';
      return;
    }
    let parsed;
    try {
      parsed = parseCsv(this.text);
    } catch (err) {
      this.errorMsg = `Couldn't parse the CSV: ${(err as Error).message}`;
      return;
    }
    if (parsed.columns.length === 0 || parsed.rows.length === 0) {
      this.errorMsg = 'No data found in the pasted text.';
      return;
    }
    const ctx = await getContext();
    const tableId = crypto.randomUUID();
    await ctx.store.tables.insert({
      id: tableId,
      workspaceId: ctx.workspaceId,
      name,
      code: slug(name),
      columns: parsed.columns,
      view: 'table',
      updatedAt: Date.now(),
    });
    const docs = parsed.rows.map((r) => ({
      id: crypto.randomUUID(),
      tableId,
      data: r,
      updatedAt: Date.now(),
    }));
    await ctx.store.rows(tableId).bulkInsert(docs);
    ctx.api.ui.dialogs.toast(
      `Imported ${parsed.rows.length} row${parsed.rows.length === 1 ? '' : 's'} into "${name}".`,
      { kind: 'success', title: 'CSV paste' },
    );
    this.close();
  }

  override render() {
    return html`
      <dialog @cancel=${this.close}>
        <button type="button" class="close-x" title="Close" @click=${this.close}>×</button>
        <form @submit=${this.submit}>
          <h2>Paste CSV</h2>
          <p class="hint">
            First line is treated as the header. Separator is auto-detected
            (comma / semicolon / tab). Column types are inferred from data.
          </p>
          <label>
            Table name
            <input
              type="text"
              autofocus
              .value=${this.name}
              placeholder="pasted"
              @input=${(e: Event) => (this.name = (e.target as HTMLInputElement).value)}
            />
          </label>
          <label>
            CSV
            <textarea
              spellcheck="false"
              .value=${this.text}
              @input=${(e: Event) => (this.text = (e.target as HTMLTextAreaElement).value)}
            ></textarea>
          </label>
          ${this.errorMsg ? html`<div class="error">${this.errorMsg}</div>` : ''}
          <div class="actions">
            <button type="button" class="ghost" @click=${this.close}>Cancel</button>
            <button type="submit" class="primary">Import</button>
          </div>
        </form>
      </dialog>
    `;
  }
}

function slug(s: string): string {
  return (
    s
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'table'
  );
}

declare global {
  interface HTMLElementTagNameMap {
    'csv-paste-dialog': CsvPasteDialog;
  }
}
