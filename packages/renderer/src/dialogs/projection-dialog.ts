// packages/renderer/src/dialogs/projection-dialog.ts
//
// Editor for a Projection (a virtual table / database view / JOIN). Builds a
// `ProjectionSpec`: a base table, optional JOINs (inner/left, equijoin), and a
// selected/renamed column list including optional computed (script) columns.
//
// Pure UI: the candidate tables and an `onSave(name, spec)` callback are passed
// in via `open()`, so the dialog imports no store — the projection plugin
// compiles the spec into `Table.columns` and writes it.

import { LitElement, css, html } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import type { ColumnSpec, ColumnType, ProjectionSpec } from '@easydb/shared';
import { ctrlEnterSubmits, dialogChromeStyles } from './dialog-chrome.js';
import { makeDialogDraggable } from './draggable.js';

/** A table the projection can draw from. */
export interface ProjectionCandidate {
  id: string;
  name: string;
  columns: ColumnSpec[];
}

export interface ProjectionDialogOpts {
  candidates: ProjectionCandidate[];
  /** Edit mode: prefill from an existing projection. */
  initial?: { name: string; spec: ProjectionSpec } | undefined;
  /** Persist the projection; throw to keep the dialog open with an inline error. */
  onSave: (name: string, spec: ProjectionSpec) => Promise<void>;
}

interface EdJoin {
  type: 'inner' | 'left';
  thisField: string;
  otherAlias: string;
  otherField: string;
}

interface EdSource {
  alias: string;
  tableId: string;
  tableName: string;
  columns: ColumnSpec[];
  join?: EdJoin;
}

interface EdColumn {
  include: boolean;
  label: string;
  type: ColumnType;
  /** kind 'source' */ alias?: string;
  field?: string;
  /** kind 'script' */ script?: string;
  computed: boolean;
}

@customElement('projection-dialog')
export class ProjectionDialog extends LitElement {
  static instance: ProjectionDialog | null = null;

  static override styles = [
    dialogChromeStyles,
    css`
      dialog {
        min-width: 560px;
        max-width: 760px;
      }
      .dialog-body {
        display: flex;
        flex-direction: column;
        gap: 1rem;
      }
      h3 {
        margin: 0.2rem 0 0;
        font-size: 0.9rem;
        color: #374151;
      }
      input,
      select,
      textarea {
        font: inherit;
        padding: 0.35rem 0.45rem;
        border: 1px solid #d1d5db;
        border-radius: 0.25rem;
        background: white;
      }
      .row {
        display: flex;
        align-items: center;
        gap: 0.5rem;
        flex-wrap: wrap;
      }
      .src {
        border: 1px solid #e5e7eb;
        border-radius: 0.4rem;
        padding: 0.6rem;
        display: flex;
        flex-direction: column;
        gap: 0.5rem;
      }
      .cols {
        display: grid;
        grid-template-columns: auto 1fr auto;
        gap: 0.35rem 0.5rem;
        align-items: center;
      }
      .muted {
        color: #6b7280;
        font-size: 0.78rem;
      }
      .err {
        color: #b91c1c;
        font-size: 0.82rem;
        min-height: 1.1em;
      }
      button.ghost.sm {
        padding: 0.2rem 0.5rem;
        font-size: 0.8rem;
      }
      textarea {
        width: 100%;
        min-height: 3.5rem;
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        font-size: 0.78rem;
      }
    `,
  ];

  @state() private name = '';
  @state() private sources: EdSource[] = [];
  @state() private columns: EdColumn[] = [];
  @state() private error = '';

  private candidates: ProjectionCandidate[] = [];
  private editing = false;
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
    if (opts.initial) this.loadFrom(opts.initial.name, opts.initial.spec);
    else {
      this.name = '';
      this.sources = [];
      this.columns = [];
      // Seed the base source with the first candidate, if any.
      if (this.candidates[0]) this.addSource(this.candidates[0].id);
    }
    void this.updateComplete.then(() => this.dialogEl?.showModal());
  }

  private loadFrom(name: string, spec: ProjectionSpec): void {
    this.name = name;
    this.sources = spec.sources.map((s) => {
      const cand = this.candidates.find((c) => c.name === s.tableName) ?? this.candidates.find((c) => c.id === s.tableId);
      const key0 = s.join?.on[0];
      return {
        alias: s.alias,
        tableId: cand?.id ?? s.tableId ?? '',
        tableName: s.tableName,
        columns: cand?.columns ?? [],
        ...(s.join && key0
          ? { join: { type: s.join.type, thisField: key0.field, otherAlias: key0.eqAlias, otherField: key0.eqField } }
          : {}),
      };
    });
    this.columns = spec.columns.map((c) =>
      c.from.kind === 'source'
        ? { include: true, label: c.label, type: c.type, alias: c.from.alias, field: c.from.field, computed: false }
        : { include: true, label: c.label, type: c.type, script: c.from.script, computed: true },
    );
  }

  private nextAlias(): string {
    for (let i = 0; ; i++) {
      const a = String.fromCharCode(97 + (i % 26)) + (i >= 26 ? String(Math.floor(i / 26)) : '');
      if (!this.sources.some((s) => s.alias === a)) return a;
    }
  }

  private addSource(tableId: string): void {
    const cand = this.candidates.find((c) => c.id === tableId);
    if (!cand) return;
    const alias = this.nextAlias();
    const isBase = this.sources.length === 0;
    const src: EdSource = {
      alias,
      tableId: cand.id,
      tableName: cand.name,
      columns: cand.columns,
      ...(isBase ? {} : { join: { type: 'left', thisField: cand.columns[0]?.field ?? '', otherAlias: this.sources[0]?.alias ?? '', otherField: '' } }),
    };
    this.sources = [...this.sources, src];
    // Add this source's columns to the selection (included by default).
    this.columns = [
      ...this.columns,
      ...cand.columns.map((col) => ({ include: true, label: col.label, type: col.type, alias, field: col.field, computed: false })),
    ];
  }

  private removeSource(alias: string): void {
    this.sources = this.sources.filter((s) => s.alias !== alias);
    this.columns = this.columns.filter((c) => c.computed || c.alias !== alias);
  }

  private addComputed(): void {
    this.columns = [
      ...this.columns,
      { include: true, label: 'computed', type: 'string', script: 'function render(row) {\n  return "";\n}', computed: true },
    ];
  }

  private patchSource(alias: string, patch: Partial<EdJoin>): void {
    this.sources = this.sources.map((s) =>
      s.alias === alias && s.join ? { ...s, join: { ...s.join, ...patch } } : s,
    );
  }

  private buildSpec(): { name: string; spec: ProjectionSpec } | null {
    const name = this.name.trim();
    if (!name) return this.fail('Give the projection a name.');
    if (this.sources.length === 0) return this.fail('Add at least one source table.');
    const chosen = this.columns.filter((c) => c.include);
    if (chosen.length === 0) return this.fail('Select at least one column.');

    for (const s of this.sources) {
      if (s.join && (!s.join.thisField || !s.join.otherField)) {
        return this.fail(`Set both join keys for "${s.tableName}".`);
      }
    }

    const usedFields = new Set<string>();
    const outColumns = chosen.map((c) => {
      const field = uniqueField(c.label, usedFields);
      return c.computed
        ? { field, label: c.label.trim() || field, type: c.type, from: { kind: 'script' as const, script: c.script ?? '' } }
        : { field, label: c.label.trim() || field, type: c.type, from: { kind: 'source' as const, alias: c.alias!, field: c.field! } };
    });

    const spec: ProjectionSpec = {
      version: 1,
      sources: this.sources.map((s) => ({
        alias: s.alias,
        tableName: s.tableName,
        tableId: s.tableId,
        ...(s.join
          ? { join: { type: s.join.type, on: [{ field: s.join.thisField, eqAlias: s.join.otherAlias, eqField: s.join.otherField }] } }
          : {}),
      })),
      columns: outColumns,
    };
    return { name, spec };
  }

  private fail(msg: string): null {
    this.error = msg;
    return null;
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
            <label class="row">
              Name
              <input .value=${this.name} @input=${(e: Event) => (this.name = (e.target as HTMLInputElement).value)} />
            </label>

            <h3>Sources</h3>
            ${this.sources.map((s, i) => this.renderSource(s, i === 0))}
            <div class="row">
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
            </div>

            <h3>Columns</h3>
            <div class="cols">
              ${this.columns.map((c, i) => this.renderColumn(c, i))}
            </div>
            <div class="row">
              <button type="button" class="ghost sm" @click=${() => this.addComputed()}>+ Computed column</button>
            </div>

            <div class="err">${this.error}</div>
          </div>
        </form>
      </dialog>
    `;
  }

  private renderSource(s: EdSource, isBase: boolean) {
    return html`
      <div class="src">
        <div class="row">
          <strong>${s.tableName}</strong>
          <span class="muted">${isBase ? '(base)' : ''} alias “${s.alias}”</span>
          ${isBase ? '' : html`<button type="button" class="ghost sm" @click=${() => this.removeSource(s.alias)}>Remove</button>`}
        </div>
        ${s.join
          ? html`<div class="row">
              <select
                .value=${s.join.type}
                @change=${(e: Event) => this.patchSource(s.alias, { type: (e.target as HTMLSelectElement).value as 'inner' | 'left' })}
              >
                <option value="left">LEFT JOIN</option>
                <option value="inner">INNER JOIN</option>
              </select>
              on
              <select
                .value=${s.join.thisField}
                @change=${(e: Event) => this.patchSource(s.alias, { thisField: (e.target as HTMLSelectElement).value })}
              >
                ${s.columns.map((col) => html`<option value=${col.field} ?selected=${col.field === s.join?.thisField}>${s.alias}.${col.field}</option>`)}
              </select>
              =
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
    return html`
      <input type="checkbox" .checked=${c.include} @change=${(e: Event) => set({ include: (e.target as HTMLInputElement).checked })} />
      ${c.computed
        ? html`<div class="row" style="flex-direction:column;align-items:stretch;gap:0.25rem;">
            <div class="row">
              <input .value=${c.label} @input=${(e: Event) => set({ label: (e.target as HTMLInputElement).value })} />
              <span class="muted">computed</span>
            </div>
            <textarea .value=${c.script ?? ''} @input=${(e: Event) => set({ script: (e.target as HTMLTextAreaElement).value })}></textarea>
          </div>`
        : html`<div class="row">
            <span class="muted">${c.alias}.${c.field} →</span>
            <input .value=${c.label} @input=${(e: Event) => set({ label: (e.target as HTMLInputElement).value })} />
          </div>`}
      <span></span>
    `;
  }
}

/** Slugify a label to a unique output field name. */
function uniqueField(label: string, used: Set<string>): string {
  const base = label.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'col';
  let field = base;
  let n = 2;
  while (used.has(field)) field = `${base}_${n++}`;
  used.add(field);
  return field;
}

declare global {
  interface HTMLElementTagNameMap {
    'projection-dialog': ProjectionDialog;
  }
}
