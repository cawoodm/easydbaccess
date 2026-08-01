// packages/renderer/src/dialogs/projection-dialog.ts
//
// Editor for a Projection (a virtual table / database view / JOIN). Builds a
// `ProjectionSpec`: a base table, optional JOINs (inner/left, equijoin), and a
// selected/renamed column list including optional computed (script) columns.
//
// Pure UI: the candidate tables and an `onSave(name, spec)` callback are passed
// in via `open()`, so the dialog imports no store — the projection plugin
// compiles the spec into `Table.columns` and writes it.

import { LitElement, css, html, nothing } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import type { ColumnType, ProjectionSpec } from '@easydb/shared';
import { ctrlEnterSubmits, dialogChromeStyles } from './dialog-chrome.js';
import { makeDialogDraggable } from './draggable.js';
import {
  addComputedToModel,
  addSourceToModel,
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

/** Offered in each column's type picker; drives coercion / sort / SQL typing. */
const COLUMN_TYPES: ColumnType[] = ['string', 'number', 'date', 'datetime', 'boolean'];

export interface ProjectionDialogOpts {
  /** Tables offered as JOIN sources (excludes the base). */
  candidates: ProjectionCandidate[];
  /** New mode: the fixed base (first source) — the table the editor launched from. */
  base?: ProjectionCandidate | undefined;
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

      /* -- columns --------------------------------------------------------- */
      .cols {
        display: grid;
        gap: 0.3rem;
      }
      .col-header,
      .col-row {
        display: grid;
        grid-template-columns: 1.25rem minmax(0, 10rem) minmax(0, 1fr) 7rem 1.5rem;
        gap: 0.45rem;
        align-items: center;
      }
      .col-header {
        font-size: 0.7rem;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        color: #9ca3af;
        padding-bottom: 0.15rem;
        border-bottom: 1px solid #f3f4f6;
        /* The body scrolls once a projection has a few sources, so keep the
           column headings in view above the list. */
        position: sticky;
        top: -0.1rem;
        background: white;
        z-index: 1;
      }
      .col-row input[type='checkbox'] {
        margin: 0;
        justify-self: center;
      }
      /* An unselected column stays legible but visibly out of the projection. */
      .col-row.excluded .src-ref,
      .col-row.excluded input,
      .col-row.excluded select {
        opacity: 0.5;
      }
      .src-ref {
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        font-size: 0.74rem;
        color: #6b7280;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .chip {
        justify-self: start;
        font-size: 0.68rem;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        color: #1d4ed8;
        background: #dbeafe;
        border-radius: 0.2rem;
        padding: 0.1rem 0.35rem;
      }
      textarea.script {
        grid-column: 2 / -1;
        width: 100%;
        box-sizing: border-box;
        min-height: 3.4rem;
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        font-size: 0.76rem;
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
  }

  open(opts: ProjectionDialogOpts): void {
    this.candidates = opts.candidates;
    this.onSave = opts.onSave;
    this.error = '';
    this.editing = !!opts.initial;
    this.originalSpec = null;
    this.name = '';
    this.sources = [];
    this.columns = [];
    if (opts.initial) {
      this.loadFrom(opts.initial.name, opts.initial.spec);
    } else if (opts.base) {
      // The base table is fixed (it's the table the button launched from); seed
      // it as source 0. The user only picks join tables from `candidates`.
      this.name = `${opts.base.name} view`;
      this.addCandidateAsSource(opts.base);
    }
    void this.updateComplete.then(() => this.dialogEl?.showModal());
  }

  /** The editor state as one model, for the pure transforms in projection-spec. */
  private modelOf(): EditorModel {
    return {
      name: this.name,
      sources: this.sources,
      columns: this.columns,
      ...(this.originalSpec ? { original: this.originalSpec } : {}),
    };
  }

  private applyModel(m: EditorModel): void {
    this.name = m.name;
    this.sources = m.sources;
    this.columns = m.columns;
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
    this.sources = this.sources.map((s) =>
      s.alias === alias && s.join ? { ...s, join: { ...s.join, ...patch } } : s,
    );
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
            <label>
              Name
              <input
                id="proj-name"
                .value=${this.name}
                @input=${(e: Event) => (this.name = (e.target as HTMLInputElement).value)}
              />
            </label>

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
                    const sel = this.shadowRoot?.getElementById(
                      'add-src',
                    ) as HTMLSelectElement | null;
                    if (sel?.value) this.addSource(sel.value);
                  }}
                >
                  ${base ? '+ Join table' : '+ Base table'}
                </button>
                ${base
                  ? html`<span class="hint">A table may be joined more than once.</span>`
                  : nothing}
              </div>
            </section>

            <section>
              <div class="section-head">
                <h3>Columns</h3>
                <span class="hint">Tick the columns to include, and rename them freely.</span>
              </div>
              <div class="cols">
                <div class="col-header">
                  <span></span><span>Source</span><span>Label</span><span>Type</span><span></span>
                </div>
                ${this.columns.map((c, i) => this.renderColumn(c, i))}
              </div>
              <div class="add-row">
                <button type="button" class="ghost sm" @click=${() => this.addComputed()}>
                  + Computed column
                </button>
              </div>
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
          ${isBase
            ? nothing
            : html`<button
                type="button"
                class="icon-btn"
                title="Remove this join"
                aria-label="Remove ${s.tableName}"
                @click=${() => this.removeSource(s.alias)}
              >
                ×
              </button>`}
        </div>
        ${s.join
          ? html`<div class="join-grid">
              <select
                .value=${s.join.type}
                @change=${(e: Event) => this.patchSource(s.alias, { type: (e.target as HTMLSelectElement).value as 'inner' | 'left' })}
              >
                <option value="left">LEFT JOIN</option>
                <option value="inner">INNER JOIN</option>
              </select>
              <span class="kw">ON</span>
              <select
                .value=${s.join.thisField}
                @change=${(e: Event) => this.patchSource(s.alias, { thisField: (e.target as HTMLSelectElement).value })}
              >
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
                    (col) =>
                      html`<option
                        value=${`${os.alias}.${col.field}`}
                        ?selected=${os.alias === s.join?.otherAlias && col.field === s.join?.otherField}
                      >
                        ${os.alias}.${col.field}
                      </option>`,
                  ),
                )}
              </select>
            </div>`
          : ''}
      </div>
    `;
  }

  private renderColumn(c: EdColumn, i: number) {
    const set = (patch: Partial<EdColumn>) => {
      this.columns = this.columns.map((x, j) => (j === i ? { ...x, ...patch } : x));
    };
    const label = c.label || c.field || 'column';
    return html`
      <div class="col-row ${c.include ? '' : 'excluded'}">
        <input
          type="checkbox"
          .checked=${c.include}
          aria-label=${`Include ${label}`}
          @change=${(e: Event) => set({ include: (e.target as HTMLInputElement).checked })}
        />
        ${c.computed
          ? html`<span class="chip">computed</span>`
          : html`<span class="src-ref" title=${`${c.alias}.${c.field}`}>
              ${c.alias}.${c.field}
            </span>`}
        <input
          .value=${c.label}
          aria-label=${`Label for ${label}`}
          @input=${(e: Event) => set({ label: (e.target as HTMLInputElement).value })}
        />
        <select
          aria-label=${`Type of ${label}`}
          .value=${c.type}
          @change=${(e: Event) => set({ type: (e.target as HTMLSelectElement).value as ColumnType })}
        >
          ${COLUMN_TYPES.map(
            (t) => html`<option value=${t} ?selected=${t === c.type}>${t}</option>`,
          )}
        </select>
        ${c.computed
          ? html`<button
              type="button"
              class="icon-btn"
              title="Remove this computed column"
              aria-label=${`Remove ${label}`}
              @click=${() => {
                this.columns = this.columns.filter((_, j) => j !== i);
              }}
            >
              ×
            </button>`
          : html`<span></span>`}
        ${c.computed
          ? html`<textarea
              class="script"
              aria-label=${`Script for ${label}`}
              spellcheck="false"
              .value=${c.script ?? ''}
              @input=${(e: Event) => set({ script: (e.target as HTMLTextAreaElement).value })}
            ></textarea>`
          : nothing}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'projection-dialog': ProjectionDialog;
  }
}
