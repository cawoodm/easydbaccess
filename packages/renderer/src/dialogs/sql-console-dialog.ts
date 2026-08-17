import { LitElement, css, html } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { splitStatements, type SqlRunResult } from '@easydb/shared';
import { getContext } from '../app-context.js';
import { ctrlEnterSubmits, dialogChromeStyles, makeDialogDraggable } from '@marccawood/lit-dialogs';

/**
 * The SQL console.
 *
 * A workspace is a real SQLite database, and this is where that stops being an
 * implementation detail. It runs against the SAME connection the app uses, not
 * a copy, so a `SELECT` sees uncommitted-to-disk edits and a write is
 * immediately visible in the grids.
 *
 * Three things shape the design:
 *
 * 1. **Read-only is the default, and it is SQLite that enforces it** (`PRAGMA
 *    query_only`, in `EdbStore.runSql`). The checkbox here only chooses which
 *    mode to ask for; it does not do the guarding, which is why a statement
 *    like `WITH x AS (…) DELETE …` cannot slip past it.
 * 2. **A script runs statement by statement.** `prepare` compiles one statement
 *    and ignores the rest, so pasting three and running would otherwise execute
 *    the first and report success for all three. `splitStatements` does the
 *    lexing; the grid shows the last statement that returned rows.
 * 3. **Results are capped.** A console is for looking, and `SELECT * FROM` a
 *    609k-row table should not try to render 609k rows.
 */

/** Rows past this are not fetched. High enough to be useful, low enough to render. */
const MAX_ROWS = 500;

/** What one run produced, for the status line. */
interface RunSummary {
  statements: number;
  changes: number;
  elapsedMs: number;
  /** The last statement that returned rows, if any did. */
  result: SqlRunResult | null;
}

@customElement('sql-console-dialog')
export class SqlConsoleDialog extends LitElement {
  static override styles = [
    dialogChromeStyles,
    css`
      dialog {
        width: 900px;
        max-width: 94vw;
      }
      textarea {
        font:
          0.85rem ui-monospace,
          SFMono-Regular,
          monospace;
        width: 100%;
        box-sizing: border-box;
        padding: 0.5rem;
        border: 1px solid #d1d5db;
        border-radius: 0.25rem;
        min-height: 140px;
        resize: vertical;
      }
      .bar {
        display: flex;
        align-items: center;
        gap: 0.75rem;
        flex-wrap: wrap;
        font-size: 0.85rem;
        color: #374151;
      }
      .bar label {
        display: flex;
        align-items: center;
        gap: 0.35rem;
      }
      .spacer {
        flex: 1;
      }
      .status {
        font-size: 0.85rem;
        color: #6b7280;
      }
      .error {
        color: #b91c1c;
        font:
          0.8rem ui-monospace,
          SFMono-Regular,
          monospace;
        white-space: pre-wrap;
        background: #fef2f2;
        border: 1px solid #fecaca;
        border-radius: 0.25rem;
        padding: 0.5rem;
      }
      .warn {
        color: #92400e;
        background: #fffbeb;
        border: 1px solid #fde68a;
        border-radius: 0.25rem;
        padding: 0.4rem 0.5rem;
        font-size: 0.8rem;
      }
      .results {
        overflow: auto;
        max-height: 44vh;
        border: 1px solid #e5e7eb;
        border-radius: 0.25rem;
      }
      table {
        border-collapse: collapse;
        font-size: 0.82rem;
        width: 100%;
      }
      th,
      td {
        border-bottom: 1px solid #f3f4f6;
        padding: 0.3rem 0.5rem;
        text-align: left;
        white-space: nowrap;
      }
      th {
        position: sticky;
        top: 0;
        background: #f9fafb;
        font-weight: 600;
      }
      td.null {
        color: #9ca3af;
        font-style: italic;
      }
    `,
  ];

  @state() private sql = '';
  @state() private allowWrites = false;
  @state() private busy = false;
  @state() private errorMsg = '';
  @state() private summary: RunSummary | null = null;

  private dialogEl: HTMLDialogElement | null = null;

  override firstUpdated(): void {
    this.dialogEl = this.shadowRoot?.querySelector('dialog') ?? null;
    const header = this.shadowRoot?.querySelector('.dialog-header') as HTMLElement | null;
    if (this.dialogEl && header) makeDialogDraggable(this.dialogEl, header);
  }

  async open(seed?: string): Promise<void> {
    // The text survives a close so a console keeps its place across openings;
    // an explicit seed (from a commandlet, say) replaces it.
    if (seed !== undefined) this.sql = seed;
    this.errorMsg = '';
    await this.updateComplete;
    this.dialogEl?.showModal();
    this.shadowRoot?.querySelector('textarea')?.focus();
  }

  private close(): void {
    this.dialogEl?.close();
  }

  private async run(e: Event): Promise<void> {
    e.preventDefault();
    if (this.busy) return;
    const statements = splitStatements(this.sql);
    if (statements.length === 0) {
      this.errorMsg = 'Nothing to run.';
      this.summary = null;
      return;
    }

    const ctx = await getContext();
    const sql = ctx.store.sql;
    if (!sql) {
      // The button should not exist in this case, so this is a guard against a
      // store that changed under a dialog left open, not an expected path.
      this.errorMsg = 'This workspace is not backed by a database that can run SQL.';
      return;
    }

    this.busy = true;
    this.errorMsg = '';
    let changes = 0;
    let elapsedMs = 0;
    let last: SqlRunResult | null = null;
    try {
      for (const statement of statements) {
        const res = await sql.run(statement.sql, { write: this.allowWrites, maxRows: MAX_ROWS });
        elapsedMs += res.elapsedMs;
        changes += res.changes ?? 0;
        // The grid shows the last statement that actually produced rows, so a
        // script ending in a write still displays the SELECT before it.
        if (res.columns.length > 0) last = res;
      }
      this.summary = { statements: statements.length, changes, elapsedMs, result: last };
    } catch (err) {
      // Which statement failed matters when a script is half-applied — the
      // earlier ones have already run and are not rolled back.
      this.errorMsg = err instanceof Error ? err.message : String(err);
      this.summary = null;
    } finally {
      this.busy = false;
    }
  }

  private renderCell(value: unknown) {
    if (value === null || value === undefined) return html`<td class="null">NULL</td>`;
    if (value instanceof Uint8Array) return html`<td class="null">&lt;${value.byteLength} bytes&gt;</td>`;
    return html`<td>${String(value)}</td>`;
  }

  private renderResults() {
    const res = this.summary?.result;
    if (!res) return '';
    return html`
      <div class="results">
        <table>
          <thead>
            <tr>
              ${res.columns.map((c) => html`<th>${c}</th>`)}
            </tr>
          </thead>
          <tbody>
            ${res.rows.map(
              (r) =>
                html`<tr>
                  ${r.map((v) => this.renderCell(v))}
                </tr>`,
            )}
          </tbody>
        </table>
      </div>
      ${res.truncated ? html`<div class="warn">Showing the first ${MAX_ROWS} rows. Add a LIMIT, or narrow the query, to see the rest.</div>` : ''}
    `;
  }

  private renderStatus() {
    if (this.busy) return html`<div class="status">Running…</div>`;
    const s = this.summary;
    if (!s) return '';
    const parts = [`${s.statements} statement${s.statements === 1 ? '' : 's'}`];
    if (s.result) parts.push(`${s.result.rows.length} row${s.result.rows.length === 1 ? '' : 's'}`);
    if (this.allowWrites) parts.push(`${s.changes} row${s.changes === 1 ? '' : 's'} changed`);
    parts.push(`${s.elapsedMs} ms`);
    return html`<div class="status">${parts.join(' · ')}</div>`;
  }

  override render() {
    return html`
      <dialog @cancel=${this.close} @keydown=${ctrlEnterSubmits}>
        <button type="button" class="close-x" title="Close" @click=${this.close}>×</button>
        <form @submit=${this.run}>
          <div class="dialog-header">
            <h2>SQL</h2>
            <div class="header-actions">
              <button type="button" class="ghost" @click=${this.close}>Close</button>
              <button type="submit" class="primary" ?disabled=${this.busy}>Run</button>
            </div>
          </div>
          <div class="dialog-body">
            <textarea spellcheck="false" placeholder="SELECT * FROM sqlite_master" .value=${this.sql} @input=${(e: Event) => (this.sql = (e.target as HTMLTextAreaElement).value)}></textarea>
            <div class="bar">
              <label>
                <input type="checkbox" .checked=${this.allowWrites} @change=${(e: Event) => (this.allowWrites = (e.target as HTMLInputElement).checked)} />
                Allow writes
              </label>
              <span class="spacer"></span>
              ${this.renderStatus()}
            </div>
            ${this.allowWrites
              ? html`<div class="warn">
                  Writes go straight to the database, around the rules the app enforces. Dropping or renaming a table here leaves the workspace pointing at something that is no longer there. Nothing
                  is rolled back if a later statement in the script fails.
                </div>`
              : ''}
            ${this.errorMsg ? html`<div class="error">${this.errorMsg}</div>` : ''} ${this.renderResults()}
          </div>
        </form>
      </dialog>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'sql-console-dialog': SqlConsoleDialog;
  }
}
