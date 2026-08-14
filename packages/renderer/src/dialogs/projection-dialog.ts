// packages/renderer/src/dialogs/projection-dialog.ts
//
// Editor for a Projection's STRUCTURE (a virtual table / database view / JOIN):
// a base table, optional JOINs (inner/left, equijoin), which columns to include,
// and the script behind any computed column.
//
// Deliberately NOT a column editor. Labels, types, renderers, widths and the
// rest are inherited from the source table when a column first appears and are
// then edited with the ordinary column editor, exactly as on any table — so this
// dialog stays small and there is one place to learn.
//
// Pure UI: the candidate tables and an `onSave(name, spec)` callback are passed
// in via `open()`, so the dialog imports no store — the projection plugin turns
// the spec into the table's columns and writes it.

import { LitElement, css, html, nothing } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import type { ProjectionSpec } from '@easydb/shared';
import { ctrlEnterSubmits, dialogChromeStyles, makeDialogDraggable } from '@marccawood/lit-dialogs';
import { watchDialogDirty } from '../chrome/dirty-guard.js';
import {
  addComputedToModel,
  addSourceToModel,
  seedJoinKeyFromBase,
  editorToSpec,
  removeSourceFromModel,
  specToEditor,
  type EdColumn,
  type EditorModel,
  type EdJoin,
  type EdSource,
  type ProjectionCandidate,
} from './projection-spec.js';

export type { ProjectionCandidate };

export interface ProjectionDialogOpts {
  /** Tables offered as JOIN sources (excludes the base). */
  candidates: ProjectionCandidate[];
  /** New mode: the fixed base (first source) — the table the editor launched from. */
  base?: ProjectionCandidate | undefined;
  /**
   * New mode: a second source, already joined onto the base.
   *
   * Set when the editor was opened by dragging a column from one table onto
   * another, where the two tables are the whole point of the gesture and making
   * the user re-pick them would be asking a question they already answered.
   */
  join?: ProjectionCandidate | undefined;
  /**
   * The BASE field the join should key on, when the caller already knows it —
   * a drag names a column, and that column is the key. Absent ⇒ the name
   * heuristics decide, as picking a table from the dropdown does.
   */
  joinOn?: string | undefined;
  /** New mode: seed the WHERE, keyed by output field. */
  filters?: Record<string, string> | undefined;
  /** Edit mode: prefill from an existing projection. */
  initial?: { name: string; spec: ProjectionSpec } | undefined;
  /** Persist the projection; throw to keep the dialog open with an inline error. */
  onSave: (name: string, spec: ProjectionSpec) => Promise<void>;
}

@customElement('projection-dialog')
export class ProjectionDialog extends LitElement {
  static instance: ProjectionDialog | null = null;

  static override styles = [
    dialogChromeStyles,
    css`
      dialog {
        width: 760px;
        max-width: 96vw;
      }
      /* -- shared controls (mirrors the column editor's look) -------------- */
      input,
      select,
      textarea {
        font: inherit;
        padding: 0.4rem 0.5rem;
        border: 1px solid #d1d5db;
        border-radius: 0.25rem;
        background: white;
        color: #111827;
        min-width: 0; /* let a grid cell shrink instead of overflowing */
      }
      input:focus-visible,
      select:focus-visible,
      textarea:focus-visible {
        outline: none;
        border-color: #3b82f6;
        box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.18);
      }
      label {
        display: flex;
        flex-direction: column;
        gap: 0.25rem;
        font-size: 0.85rem;
        color: #374151;
      }
      button.ghost.sm {
        padding: 0.3rem 0.6rem;
        font-size: 0.82rem;
      }
      button.icon-btn {
        background: transparent;
        border: 0;
        color: #9ca3af;
        cursor: pointer;
        padding: 0;
        font-size: 1.05rem;
        line-height: 1;
      }
      button.icon-btn:hover {
        color: #ef4444;
      }

      /* -- sections -------------------------------------------------------- */
      section {
        display: flex;
        flex-direction: column;
        gap: 0.55rem;
        border-top: 1px solid #e5e7eb;
        padding-top: 0.9rem;
      }
      .section-head {
        display: flex;
        align-items: baseline;
        gap: 0.5rem;
        flex-wrap: wrap;
      }
      h3 {
        margin: 0;
        font-size: 0.75rem;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        color: #6b7280;
      }
      .hint {
        color: #9ca3af;
        font-size: 0.78rem;
      }
      .add-row {
        display: flex;
        align-items: center;
        gap: 0.5rem;
        flex-wrap: wrap;
      }
      .add-row select {
        max-width: 14rem;
      }
      /* Name takes the space; the row cap is a narrow field beside it. */
      .head-row {
        display: grid;
        grid-template-columns: minmax(0, 1fr) 7rem;
        gap: 0.6rem;
        align-items: end;
      }
      @media (max-width: 640px) {
        .head-row {
          grid-template-columns: 1fr;
        }
      }

      /* -- sources --------------------------------------------------------- */
      .sources {
        display: flex;
        flex-direction: column;
        gap: 0.5rem;
      }
      .src {
        border: 1px solid #e5e7eb;
        border-radius: 0.4rem;
        background: #f9fafb;
        padding: 0.6rem 0.7rem;
        display: flex;
        flex-direction: column;
        gap: 0.55rem;
      }
      .src-head {
        display: flex;
        align-items: center;
        gap: 0.5rem;
      }
      .src-head .name {
        font-weight: 600;
        color: #111827;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .src-head .spacer {
        flex: 1;
      }
      .badge {
        font-size: 0.65rem;
        font-weight: 700;
        letter-spacing: 0.05em;
        text-transform: uppercase;
        padding: 0.15rem 0.4rem;
        border-radius: 0.2rem;
        background: #e5e7eb;
        color: #4b5563;
      }
      .badge.base {
        background: #dbeafe;
        color: #1d4ed8;
      }
      code.alias {
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        font-size: 0.72rem;
        background: #eef2f7;
        color: #4b5563;
        border: 1px solid #e5e7eb;
        border-radius: 0.2rem;
        padding: 0.05rem 0.3rem;
      }
      /* One grid for every join row, so the two field pickers line up down the
         list however long the table names are. */
      .join-grid {
        display: grid;
        grid-template-columns: 8rem auto minmax(0, 1fr) auto minmax(0, 1fr);
        align-items: center;
        gap: 0.4rem;
      }
      .kw {
        font-size: 0.72rem;
        font-weight: 700;
        color: #9ca3af;
        letter-spacing: 0.04em;
      }

      /* -- columns: a dense tick list per source --------------------------- */
      .col-group {
        display: flex;
        flex-direction: column;
        gap: 0.3rem;
      }
      .group-head {
        display: flex;
        align-items: center;
        gap: 0.4rem;
        font-size: 0.78rem;
        color: #6b7280;
      }
      .group-name {
        font-weight: 600;
        color: #374151;
      }
      button.link-btn {
        background: none;
        border: 0;
        padding: 0;
        font: inherit;
        font-size: 0.75rem;
        color: #2563eb;
        cursor: pointer;
        text-decoration: underline;
      }
      .ticks {
        display: flex;
        flex-wrap: wrap;
        gap: 0.25rem 0.4rem;
      }
      /* Each column is a compact pill, so a wide table costs a couple of rows
         instead of one row per column. */
      label.tick {
        flex-direction: row;
        align-items: center;
        gap: 0.3rem;
        font-size: 0.8rem;
        color: #111827;
        border: 1px solid #e5e7eb;
        border-radius: 1rem;
        padding: 0.1rem 0.5rem 0.1rem 0.35rem;
        background: #f9fafb;
        cursor: pointer;
        max-width: 14rem;
      }
      label.tick:hover {
        border-color: #cbd5e1;
      }
      label.tick input {
        margin: 0;
      }
      label.tick .tick-name {
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        font-size: 0.74rem;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      label.tick.off {
        opacity: 0.55;
        background: transparent;
      }
      .chip {
        font-size: 0.68rem;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        color: #1d4ed8;
        background: #dbeafe;
        border-radius: 0.2rem;
        padding: 0.1rem 0.35rem;
      }
      .computed-row {
        display: grid;
        grid-template-columns: 1.1rem minmax(0, 1fr) 1.3rem;
        gap: 0.4rem;
        align-items: start;
      }
      .computed-row.off {
        opacity: 0.55;
      }
      .computed-row input[type='checkbox'] {
        margin: 0.4rem 0 0;
      }
      textarea.script {
        width: 100%;
        box-sizing: border-box;
        min-height: 2.9rem;
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        font-size: 0.75rem;
      }

      .err {
        color: #b91c1c;
        font-size: 0.82rem;
        min-height: 1.1em;
      }
      .err:not(:empty) {
        background: #fef2f2;
        border: 1px solid #fecaca;
        border-radius: 0.25rem;
        padding: 0.4rem 0.55rem;
      }

      /* Phones: the dialog is full-screen (see dialog-chrome), so let the
         multi-column grids stack rather than squeeze. */
      @media (max-width: 640px) {
        .join-grid,
        .col-header,
        .col-row {
          grid-template-columns: 1fr;
        }
        .col-header {
          display: none;
        }
        .col-row {
          border: 1px solid #f3f4f6;
          border-radius: 0.3rem;
          padding: 0.45rem;
        }
        /* Stacked, the centred checkbox floats mid-row — align it with the rest. */
        .col-row input[type='checkbox'] {
          justify-self: start;
        }
        textarea.script {
          grid-column: 1;
        }
      }
    `,
  ];

  @state() private name = '';
  /** Held as a string so the field can be blank (= no limit). */
  @state() private limit = '';
  @state() private sources: EdSource[] = [];
  @state() private columns: EdColumn[] = [];
  @state() private error = '';

  private candidates: ProjectionCandidate[] = [];
  private editing = false;
  /** The spec being edited, so a save preserves fields the UI does not model. */
  private originalSpec: ProjectionSpec | null = null;
  private dialogEl: HTMLDialogElement | null = null;
  private onSave?: ((name: string, spec: ProjectionSpec) => Promise<void>) | undefined;

  override connectedCallback(): void {
    super.connectedCallback();
    ProjectionDialog.instance = this;
  }
  override disconnectedCallback(): void {
    super.disconnectedCallback();
    if (ProjectionDialog.instance === this) ProjectionDialog.instance = null;
  }
  override firstUpdated(): void {
    this.dialogEl = this.shadowRoot?.querySelector('dialog') ?? null;
    const header = this.shadowRoot?.querySelector('.dialog-header') as HTMLElement | null;
    if (this.dialogEl && header) makeDialogDraggable(this.dialogEl, header);
    if (this.dialogEl) watchDialogDirty('projection', this.dialogEl);
  }

  open(opts: ProjectionDialogOpts): void {
    this.candidates = opts.candidates;
    this.onSave = opts.onSave;
    this.error = '';
    this.editing = !!opts.initial;
    this.originalSpec = null;
    this.name = '';
    this.limit = '';
    this.sources = [];
    this.columns = [];
    if (opts.initial) {
      this.loadFrom(opts.initial.name, opts.initial.spec);
    } else if (opts.base) {
      // The base table is fixed (it's the table the button launched from); seed
      // it as source 0. The user only picks join tables from `candidates`.
      this.name = `${opts.base.name} view`;
      this.addCandidateAsSource(opts.base);
      if (opts.join) {
        this.addCandidateAsSource(opts.join);
        this.name = `${opts.base.name} + ${opts.join.name}`;
        if (opts.joinOn) this.applyModel(seedJoinKeyFromBase(this.modelOf(), opts.joinOn));
      }
      // Ride in on `original`, which `editorToSpec` spreads first precisely so
      // that what the editor does not model survives a save. `filters` is the
      // one such field, and this is a new spec, so there is nothing to overwrite.
      if (opts.filters && Object.keys(opts.filters).length > 0) {
        this.originalSpec = { version: 1, sources: [], columns: [], filters: opts.filters };
      }
    }
    void this.updateComplete.then(() => this.dialogEl?.showModal());
  }

  /** The editor state as one model, for the pure transforms in projection-spec. */
  private modelOf(): EditorModel {
    const n = Number(this.limit);
    return {
      name: this.name,
      sources: this.sources,
      columns: this.columns,
      ...(this.limit.trim() !== '' && Number.isFinite(n) && n > 0 ? { limit: Math.floor(n) } : {}),
      ...(this.originalSpec ? { original: this.originalSpec } : {}),
    };
  }

  private applyModel(m: EditorModel): void {
    this.name = m.name;
    this.sources = m.sources;
    this.columns = m.columns;
    this.limit = m.limit != null && m.limit > 0 ? String(m.limit) : '';
  }

  private loadFrom(name: string, spec: ProjectionSpec): void {
    this.originalSpec = spec;
    this.applyModel(specToEditor(name, spec, this.candidates));
  }

  private addSource(tableId: string): void {
    const cand = this.candidates.find((c) => c.id === tableId);
    if (cand) this.addCandidateAsSource(cand);
  }

  private addCandidateAsSource(cand: ProjectionCandidate): void {
    this.applyModel(addSourceToModel(this.modelOf(), cand));
  }

  private removeSource(alias: string): void {
    this.applyModel(removeSourceFromModel(this.modelOf(), alias));
  }

  private addComputed(): void {
    this.applyModel(addComputedToModel(this.modelOf()));
  }

  private patchSource(alias: string, patch: Partial<EdJoin>): void {
    this.sources = this.sources.map((s) => (s.alias === alias && s.join ? { ...s, join: { ...s.join, ...patch } } : s));
  }

  private buildSpec(): { name: string; spec: ProjectionSpec } | null {
    const built = editorToSpec(this.modelOf());
    if (!built.ok) {
      this.error = built.error;
      return null;
    }
    return { name: built.name, spec: built.spec };
  }

  private submit = async (e: Event): Promise<void> => {
    e.preventDefault();
    this.error = '';
    const built = this.buildSpec();
    if (!built || !this.onSave) return;
    try {
      await this.onSave(built.name, built.spec);
    } catch (err) {
      this.error = (err as Error)?.message ?? String(err);
      return;
    }
    this.dialogEl?.close();
  };

  private aliasesBefore(alias: string): EdSource[] {
    const idx = this.sources.findIndex((s) => s.alias === alias);
    return this.sources.slice(0, idx);
  }

  override render() {
    const base = this.sources[0];
    return html`
      <dialog @cancel=${() => this.dialogEl?.close()} @keydown=${ctrlEnterSubmits}>
        <button type="button" class="close-x" title="Close" @click=${() => this.dialogEl?.close()}>×</button>
        <form @submit=${this.submit}>
          <div class="dialog-header">
            <h2>${this.editing ? 'Edit Projection' : 'New Projection'}</h2>
            <div class="header-actions">
              <button type="button" class="ghost" @click=${() => this.dialogEl?.close()}>Cancel</button>
              <button type="submit" class="primary">Save</button>
            </div>
          </div>
          <div class="dialog-body">
            <div class="head-row">
              <label>
                Name
                <input id="proj-name" .value=${this.name} @input=${(e: Event) => (this.name = (e.target as HTMLInputElement).value)} />
              </label>
              <label>
                Row limit
                <input
                  id="proj-limit"
                  type="number"
                  min="0"
                  placeholder="all"
                  .value=${this.limit}
                  title="Cap the number of rows (TOP N). Blank or 0 shows every row."
                  @input=${(e: Event) => (this.limit = (e.target as HTMLInputElement).value)}
                />
              </label>
            </div>

            <section>
              <div class="section-head">
                <h3>Sources</h3>
                <span class="hint">The base table, plus a join for each table hung off it.</span>
              </div>
              <div class="sources">${this.sources.map((s, i) => this.renderSource(s, i === 0))}</div>
              <div class="add-row">
                <select id="add-src" ?disabled=${this.candidates.length === 0}>
                  ${this.candidates.map((c) => html`<option value=${c.id}>${c.name}</option>`)}
                </select>
                <button
                  type="button"
                  class="ghost sm"
                  @click=${() => {
                    const sel = this.shadowRoot?.getElementById('add-src') as HTMLSelectElement | null;
                    if (sel?.value) this.addSource(sel.value);
                  }}
                >
                  ${base ? '+ Join table' : '+ Base table'}
                </button>
                ${base ? html`<span class="hint">A table may be joined more than once.</span>` : nothing}
              </div>
            </section>

            <section>
              <div class="section-head">
                <h3>Columns</h3>
                <span class="hint"> Tick what the projection includes. Labels, types and formatting are inherited from the source and edited with “Edit columns”. </span>
              </div>
              ${this.sources.map((s) => this.renderSourceColumns(s))} ${this.renderComputedColumns()}
            </section>

            <div class="err">${this.error}</div>
          </div>
        </form>
      </dialog>
    `;
  }

  private renderSource(s: EdSource, isBase: boolean) {
    return html`
      <div class="src">
        <div class="src-head">
          <span class="badge ${isBase ? 'base' : ''}">${isBase ? 'Base' : 'Join'}</span>
          <span class="name">${s.tableName}</span>
          <code class="alias" title="Alias used by the join keys below">${s.alias}</code>
          <span class="spacer"></span>
          ${isBase ? nothing : html`<button type="button" class="icon-btn" title="Remove this join" aria-label="Remove ${s.tableName}" @click=${() => this.removeSource(s.alias)}>×</button>`}
        </div>
        ${s.join
          ? html`<div class="join-grid">
              <select .value=${s.join.type} @change=${(e: Event) => this.patchSource(s.alias, { type: (e.target as HTMLSelectElement).value as 'inner' | 'left' })}>
                <option value="left">LEFT JOIN</option>
                <option value="inner">INNER JOIN</option>
              </select>
              <span class="kw">ON</span>
              <select .value=${s.join.thisField} @change=${(e: Event) => this.patchSource(s.alias, { thisField: (e.target as HTMLSelectElement).value })}>
                ${s.columns.map((col) => html`<option value=${col.field} ?selected=${col.field === s.join?.thisField}>${s.alias}.${col.field}</option>`)}
              </select>
              <span class="kw">=</span>
              <select
                .value=${`${s.join.otherAlias}.${s.join.otherField}`}
                @change=${(e: Event) => {
                  const [oa, of] = (e.target as HTMLSelectElement).value.split('.');
                  this.patchSource(s.alias, { otherAlias: oa ?? '', otherField: of ?? '' });
                }}
              >
                ${this.aliasesBefore(s.alias).flatMap((os) =>
                  os.columns.map(
                    (col) => html`<option value=${`${os.alias}.${col.field}`} ?selected=${os.alias === s.join?.otherAlias && col.field === s.join?.otherField}>${os.alias}.${col.field}</option>`,
                  ),
                )}
              </select>
            </div>`
          : ''}
      </div>
    `;
  }

  /** One source's columns as a dense wrapping row of tick-boxes. */
  private renderSourceColumns(s: EdSource) {
    const mine = this.columns.map((c, i) => ({ c, i })).filter(({ c }) => !c.computed && c.alias === s.alias);
    if (mine.length === 0) return nothing;
    const allOn = mine.every(({ c }) => c.include);
    return html`
      <div class="col-group">
        <div class="group-head">
          <code class="alias">${s.alias}</code>
          <span class="group-name">${s.tableName}</span>
          <button
            type="button"
            class="link-btn"
            @click=${() => {
              const want = !allOn;
              const idx = new Set(mine.map(({ i }) => i));
              this.columns = this.columns.map((c, j) => (idx.has(j) ? { ...c, include: want } : c));
            }}
          >
            ${allOn ? 'none' : 'all'}
          </button>
        </div>
        <div class="ticks">
          ${mine.map(
            ({ c, i }) => html`
              <label class="tick ${c.include ? '' : 'off'}" title=${`${c.alias}.${c.field}`}>
                <input type="checkbox" .checked=${c.include} @change=${(e: Event) => this.setColumn(i, { include: (e.target as HTMLInputElement).checked })} />
                <span class="tick-name">${c.field}</span>
              </label>
            `,
          )}
        </div>
      </div>
    `;
  }

  /** Computed columns: a tick, the script, and a remove — no naming here. */
  private renderComputedColumns() {
    const computed = this.columns.map((c, i) => ({ c, i })).filter(({ c }) => c.computed);
    return html`
      <div class="col-group">
        <div class="group-head">
          <span class="chip">computed</span>
          <button type="button" class="link-btn" @click=${() => this.addComputed()}>+ add</button>
        </div>
        ${computed.length === 0
          ? html`<span class="hint">None. A computed column derives its value from the row.</span>`
          : computed.map(
              ({ c, i }) => html`
                <div class="computed-row ${c.include ? '' : 'off'}">
                  <input type="checkbox" .checked=${c.include} aria-label="Include computed column" @change=${(e: Event) => this.setColumn(i, { include: (e.target as HTMLInputElement).checked })} />
                  <textarea
                    class="script"
                    aria-label="Computed column script"
                    spellcheck="false"
                    .value=${c.script ?? ''}
                    @input=${(e: Event) => this.setColumn(i, { script: (e.target as HTMLTextAreaElement).value })}
                  ></textarea>
                  <button
                    type="button"
                    class="icon-btn"
                    title="Remove this computed column"
                    aria-label="Remove computed column"
                    @click=${() => {
                      this.columns = this.columns.filter((_, j) => j !== i);
                    }}
                  >
                    ×
                  </button>
                </div>
              `,
            )}
      </div>
    `;
  }

  private setColumn(i: number, patch: Partial<EdColumn>): void {
    this.columns = this.columns.map((x, j) => (j === i ? { ...x, ...patch } : x));
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'projection-dialog': ProjectionDialog;
  }
}
