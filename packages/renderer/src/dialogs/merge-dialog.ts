// packages/renderer/src/dialogs/merge-dialog.ts
//
// Settling a workspace against the copy of it in a `.edb`, table by table and —
// when the user asks — record by record.
//
// The question this answers used to have two buttons: keep the file, or keep
// what is here. Both of them are wrong whenever the two copies were BOTH worked
// on, which is the ordinary case for a folder shared between two machines. So
// the answer stops being one decision about the whole file and becomes one per
// table, with the same four choices at every level:
//
//   Push    this copy wins — the file is brought into line with it
//   Pull    the file wins — this copy is brought into line with it
//   Newest  whichever was written last wins, and nothing one-sided is lost
//   Skip    leave both copies exactly as they are
//
// Nothing is decided in here. The dialog collects answers into a `MergePlan`
// and hands it back; `replicate-run.ts` carries it out and owns every rule about
// what an answer MEANS.

import { LitElement, css, html, nothing } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { ctrlEnterSubmits, dialogChromeStyles, makeDialogDraggable } from '@marccawood/lit-dialogs';
import type { DiffState, MergeChoice, TableDiff, TableStamp } from '@easydb/shared';
import { countDiffs, defaultChoice, describeDiffs } from '@easydb/shared';
import type { Comparison, MergePlan, RecordList, RecordView } from '../db/edb/replicate-run.js';
import { formatWhen } from '../db/edb/copy-facts.js';

/** The four answers, in the order the user reads them, with what each does. */
const CHOICES: ReadonlyArray<{ value: MergeChoice; label: string; hint: string }> = [
  { value: 'newest', label: 'Newest', hint: 'Whichever was written last wins. Nothing that only one side has is lost.' },
  { value: 'here', label: 'Push', hint: 'This copy wins — the file is brought into line with it.' },
  { value: 'disk', label: 'Pull', hint: 'The file wins — this copy is brought into line with it.' },
  { value: 'skip', label: 'Skip', hint: 'Leave both copies exactly as they are.' },
];

/** What each state is called on screen. Short, because it sits in a badge. */
const STATE_LABEL: Record<DiffState, string> = {
  same: 'in step',
  differs: 'differs',
  'here-only': 'only here',
  'disk-only': 'only in the file',
};

function mountDialog(): MergeDialog {
  const el = document.createElement('merge-dialog') as MergeDialog;
  document.body.appendChild(el);
  return el;
}

/**
 * Open the comparison. Resolves with the plan to carry out, or null if the user
 * backed out — in which case NOTHING has been written on either side.
 */
export function openMergeDialog(comparison: Comparison, fileName: string): Promise<MergePlan | null> {
  const dlg = MergeDialog.instance ?? mountDialog();
  return dlg.open(comparison, fileName);
}

/** One side of a table, as a line under its name. */
function describeStamp(t: TableStamp | undefined): string {
  if (!t) return '—';
  const rows = `${t.rows.toLocaleString()} row${t.rows === 1 ? '' : 's'}`;
  const at = Math.max(t.updatedAt, t.lastRowAt);
  return at > 0 ? `${rows}, ${formatWhen(at)}` : rows;
}

@customElement('merge-dialog')
export class MergeDialog extends LitElement {
  static instance: MergeDialog | null = null;

  static override styles = [
    dialogChromeStyles,
    css`
      dialog {
        min-width: 680px;
        max-width: 900px;
      }
      .message {
        margin: 0 0 0.6rem;
        color: #374151;
        font-size: 0.9rem;
      }
      .toolbar {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 0.75rem;
        font-size: 0.82rem;
        color: #6b7280;
        margin-bottom: 0.4rem;
      }
      .toolbar button,
      .back {
        font: inherit;
        background: transparent;
        border: 0;
        color: #2563eb;
        cursor: pointer;
        padding: 0;
      }
      .toolbar button:hover,
      .back:hover {
        text-decoration: underline;
      }
      ul.rows {
        list-style: none;
        margin: 0;
        padding: 0;
        border: 1px solid #e5e7eb;
        border-radius: 0.35rem;
        max-height: 50vh;
        overflow: auto;
      }
      li {
        display: flex;
        align-items: center;
        gap: 0.6rem;
        padding: 0.45rem 0.7rem;
        border-bottom: 1px solid #f1f5f9;
      }
      li:last-child {
        border-bottom: 0;
      }
      li.same {
        opacity: 0.55;
      }
      .main {
        flex: 1;
        min-width: 0;
      }
      .name {
        font-weight: 500;
        color: #111827;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .sides {
        display: flex;
        gap: 1rem;
        font-size: 0.78rem;
        color: #6b7280;
        margin-top: 0.1rem;
      }
      .sides b {
        font-weight: 500;
        color: #374151;
      }
      .win {
        color: #15803d;
      }
      .badge {
        flex: 0 0 auto;
        font-size: 0.68rem;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        border-radius: 0.25rem;
        padding: 0.05rem 0.35rem;
        white-space: nowrap;
      }
      .badge.differs {
        color: #92400e;
        background: #fef3c7;
      }
      .badge.here-only {
        color: #1e40af;
        background: #dbeafe;
      }
      .badge.disk-only {
        color: #5b21b6;
        background: #ede9fe;
      }
      .badge.same {
        color: #4b5563;
        background: #f3f4f6;
      }
      select {
        font: inherit;
        font-size: 0.82rem;
        padding: 0.15rem 0.3rem;
        border: 1px solid #d1d5db;
        border-radius: 0.25rem;
        background: #fff;
      }
      button.records {
        font: inherit;
        font-size: 0.78rem;
        background: transparent;
        border: 1px solid #d1d5db;
        border-radius: 0.25rem;
        padding: 0.15rem 0.45rem;
        color: #374151;
        cursor: pointer;
        white-space: nowrap;
      }
      button.records:hover {
        border-color: #9ca3af;
      }
      .changed {
        font-size: 0.78rem;
        color: #92400e;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .note {
        margin: 0.5rem 0 0;
        font-size: 0.78rem;
        color: #6b7280;
      }
      .empty {
        padding: 1rem;
        text-align: center;
        color: #6b7280;
        font-size: 0.85rem;
      }
    `,
  ];

  @state() private tables: TableDiff[] = [];
  /** Table name → answer. Seeded with the union-and-newest default. */
  @state() private answers = new Map<string, MergeChoice>();
  /** Table name → per-row answers, for every table the user has drilled into. */
  @state() private rowAnswers = new Map<string, { fallback: MergeChoice; byId: Map<string, MergeChoice> }>();
  /** The table whose records are on screen, or null for the table list. */
  @state() private openTable: string | null = null;
  @state() private records: RecordList | null = null;
  @state() private loading = false;
  @state() private fileName = '';

  private comparison: Comparison | null = null;
  private dialogEl: HTMLDialogElement | null = null;
  private resolveFn: ((v: MergePlan | null) => void) | null = null;

  override connectedCallback(): void {
    super.connectedCallback();
    MergeDialog.instance = this;
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    if (MergeDialog.instance === this) MergeDialog.instance = null;
  }

  override firstUpdated(): void {
    this.dialogEl = this.shadowRoot?.querySelector('dialog') ?? null;
    const header = this.shadowRoot?.querySelector('.dialog-header') as HTMLElement | null;
    if (this.dialogEl && header) makeDialogDraggable(this.dialogEl, header);
  }

  open(comparison: Comparison, fileName: string): Promise<MergePlan | null> {
    this.comparison = comparison;
    this.fileName = fileName;
    this.tables = comparison.tables;
    // Seeded rather than blank: the default IS the recommendation, and a dialog
    // that opens with every row unanswered makes the user do the work twice.
    this.answers = new Map(comparison.tables.map((d) => [d.name, defaultChoice(d.state)]));
    this.rowAnswers = new Map();
    this.openTable = null;
    this.records = null;
    return new Promise<MergePlan | null>((resolve) => {
      this.resolveFn = resolve;
      void this.updateComplete.then(() => this.dialogEl?.showModal());
    });
  }

  private finish(value: MergePlan | null): void {
    this.dialogEl?.close();
    const resolve = this.resolveFn;
    this.resolveFn = null;
    queueMicrotask(() => resolve?.(value));
  }

  private onCancel = (e: Event): void => {
    e.preventDefault();
    this.finish(null);
  };

  private setAnswer(name: string, choice: MergeChoice): void {
    const next = new Map(this.answers);
    next.set(name, choice);
    this.answers = next;
    // Answering the table as a whole discards the row-by-row answers for it.
    // Keeping both would leave two contradictory instructions about one table,
    // and the row ones silently win in `replicate-run.ts`.
    if (this.rowAnswers.has(name)) {
      const rows = new Map(this.rowAnswers);
      rows.delete(name);
      this.rowAnswers = rows;
    }
  }

  private async showRecords(name: string): Promise<void> {
    if (!this.comparison) return;
    this.openTable = name;
    this.records = null;
    this.loading = true;
    try {
      const list = await this.comparison.recordsOf(name);
      this.records = list;
      if (!this.rowAnswers.has(name)) {
        const byId = new Map<string, MergeChoice>(list.items.map((r) => [r.diff.id, defaultChoice(r.diff.state)]));
        // The fallback covers the rows past the display cap. `newest` is the
        // same rule the seeded per-row answers follow, so what the user sees is
        // what happens to the ones they cannot.
        const next = new Map(this.rowAnswers);
        next.set(name, { fallback: 'newest', byId });
        this.rowAnswers = next;
      }
    } finally {
      this.loading = false;
    }
  }

  private setRowAnswer(id: string, choice: MergeChoice): void {
    const name = this.openTable;
    if (name === null) return;
    const current = this.rowAnswers.get(name);
    if (!current) return;
    const byId = new Map(current.byId);
    byId.set(id, choice);
    const next = new Map(this.rowAnswers);
    next.set(name, { ...current, byId });
    this.rowAnswers = next;
  }

  /** One answer for every record of the open table, including the unseen ones. */
  private setAllRows(choice: MergeChoice): void {
    const name = this.openTable;
    if (name === null || !this.records) return;
    const byId = new Map<string, MergeChoice>(this.records.items.map((r) => [r.diff.id, choice]));
    const next = new Map(this.rowAnswers);
    next.set(name, { fallback: choice, byId });
    this.rowAnswers = next;
  }

  private setAllTables(choice: MergeChoice): void {
    const next = new Map(this.answers);
    // The tables that MATCH are left alone: there is nothing to settle about
    // them, and pushing or pulling one would rewrite it for no reason.
    for (const d of this.tables) if (d.state !== 'same') next.set(d.name, choice);
    this.answers = next;
    this.rowAnswers = new Map();
  }

  private submit = (e: Event): void => {
    e.preventDefault();
    this.finish({ tables: new Map(this.answers), rows: new Map(this.rowAnswers) });
  };

  private renderChoice(value: MergeChoice, onPick: (c: MergeChoice) => void, testid: string) {
    return html`
      <select
        data-testid=${testid}
        .value=${value}
        @change=${(e: Event) => onPick((e.target as HTMLSelectElement).value as MergeChoice)}
        title=${CHOICES.find((c) => c.value === value)?.hint ?? ''}
      >
        ${CHOICES.map((c) => html`<option value=${c.value} ?selected=${c.value === value}>${c.label}</option>`)}
      </select>
    `;
  }

  private renderTableRow(d: TableDiff) {
    const answer = this.answers.get(d.name) ?? 'skip';
    const drilled = this.rowAnswers.has(d.name);
    return html`
      <li class=${d.state === 'same' ? 'same' : ''} data-testid=${`merge-table-${d.name}`}>
        <span class="main">
          <span class="name">${d.name}</span>
          <span class="sides">
            <span class=${d.newer === 'here' ? 'win' : ''}><b>Here:</b> ${describeStamp(d.here)}</span>
            <span class=${d.newer === 'disk' ? 'win' : ''}><b>File:</b> ${describeStamp(d.disk)}</span>
          </span>
        </span>
        <span class=${`badge ${d.state}`}>${STATE_LABEL[d.state]}</span>
        ${d.state === 'same'
          ? nothing
          : html`
              ${drilled ? html`<span class="badge same">by record</span>` : nothing}
              ${this.renderChoice(answer, (c) => this.setAnswer(d.name, c), `merge-choice-${d.name}`)}
              ${d.state === 'differs'
                ? html`<button type="button" class="records" data-testid=${`merge-records-${d.name}`} @click=${() => void this.showRecords(d.name)}>Compare records</button>`
                : nothing}
            `}
      </li>
    `;
  }

  private renderRecordRow(r: RecordView) {
    const answers = this.openTable === null ? undefined : this.rowAnswers.get(this.openTable);
    const answer = answers?.byId.get(r.diff.id) ?? answers?.fallback ?? 'newest';
    const changed = r.changed.length > 0 ? `changed: ${r.changed.slice(0, 6).join(', ')}${r.changed.length > 6 ? '…' : ''}` : '';
    return html`
      <li data-testid=${`merge-record-${r.diff.id}`}>
        <span class="main">
          <span class="name">${r.label}</span>
          <span class="sides">
            <span class=${r.diff.newer === 'here' ? 'win' : ''}><b>Here:</b> ${r.diff.hereAt ? formatWhen(r.diff.hereAt) : '—'}</span>
            <span class=${r.diff.newer === 'disk' ? 'win' : ''}><b>File:</b> ${r.diff.diskAt ? formatWhen(r.diff.diskAt) : '—'}</span>
            ${changed ? html`<span class="changed">${changed}</span>` : nothing}
          </span>
        </span>
        <span class=${`badge ${r.diff.state}`}>${STATE_LABEL[r.diff.state]}</span>
        ${this.renderChoice(answer, (c) => this.setRowAnswer(r.diff.id, c), `merge-row-choice-${r.diff.id}`)}
      </li>
    `;
  }

  private renderTables() {
    const counts = countDiffs(this.tables);
    const summary = describeDiffs(counts);
    return html`
      <p class="message" data-testid="merge-summary">
        ${summary === '' ? `Every table matches the copy in ${this.fileName}.` : `${summary}. Choose what happens to each, then Merge.`}
      </p>
      <div class="toolbar">
        <span>${this.tables.length} table${this.tables.length === 1 ? '' : 's'}</span>
        <span>
          Set all:
          ${CHOICES.filter((c) => c.value !== 'skip').map(
            (c) => html`<button type="button" title=${c.hint} data-testid=${`merge-all-${c.value}`} @click=${() => this.setAllTables(c.value)}>${c.label}</button>&nbsp;·&nbsp;`,
          )}
          <button type="button" data-testid="merge-all-skip" @click=${() => this.setAllTables('skip')}>Skip</button>
        </span>
      </div>
      <ul class="rows">
        ${this.tables.length === 0 ? html`<li class="empty">This workspace has no tables.</li>` : this.tables.map((d) => this.renderTableRow(d))}
      </ul>
      <p class="note">A merge settles tables and their rows. Views, templates and settings are left as each side has them.</p>
    `;
  }

  private renderRecords() {
    const list = this.records;
    return html`
      <p class="message">
        <button type="button" class="back" data-testid="merge-back" @click=${() => (this.openTable = null)}>← All tables</button>
        &nbsp;·&nbsp; Records of <b>${this.openTable}</b> that differ.
      </p>
      <div class="toolbar">
        <span>${list ? `${Math.min(list.items.length, list.total).toLocaleString()} of ${list.total.toLocaleString()} shown` : 'Reading…'}</span>
        <span>
          Set all:
          ${CHOICES.filter((c) => c.value !== 'skip').map(
            (c) => html`<button type="button" title=${c.hint} data-testid=${`merge-rows-all-${c.value}`} @click=${() => this.setAllRows(c.value)}>${c.label}</button>&nbsp;·&nbsp;`,
          )}
          <button type="button" data-testid="merge-rows-all-skip" @click=${() => this.setAllRows('skip')}>Skip</button>
        </span>
      </div>
      <ul class="rows">
        ${this.loading || !list ? html`<li class="empty">Reading records…</li>` : list.items.length === 0 ? html`<li class="empty">No record differs.</li>` : list.items.map((r) => this.renderRecordRow(r))}
      </ul>
      ${list && list.total > list.items.length
        ? html`<p class="note">The other ${(list.total - list.items.length).toLocaleString()} differing records follow the "Set all" answer above.</p>`
        : nothing}
    `;
  }

  override render() {
    return html`
      <dialog @cancel=${this.onCancel} @keydown=${ctrlEnterSubmits}>
        <button type="button" class="close-x" title="Close" @click=${() => this.finish(null)}>×</button>
        <form @submit=${this.submit}>
          <div class="dialog-header">
            <h2>Compare with ${this.fileName}</h2>
            <div class="header-actions">
              <button type="button" class="ghost" @click=${() => this.finish(null)}>Cancel</button>
              <button type="submit" class="primary" data-testid="merge-apply">Merge</button>
            </div>
          </div>
          <div class="dialog-body">${this.openTable === null ? this.renderTables() : this.renderRecords()}</div>
        </form>
      </dialog>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'merge-dialog': MergeDialog;
  }
}
