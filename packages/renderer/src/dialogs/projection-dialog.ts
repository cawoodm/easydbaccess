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
import type { ProjectionSpec } from '@easydb/shared';
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

declare global {
  interface HTMLElementTagNameMap {
    'projection-dialog': ProjectionDialog;
  }
}
