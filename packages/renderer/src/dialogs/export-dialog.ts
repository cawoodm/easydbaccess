// packages/renderer/src/dialogs/export-dialog.ts
//
// One dialog for every export. It replaced two anchored menus (a format list on
// the workspace footer, another on each table footer) and the three-button
// Raw / Visible / Structure prompt that followed them — a shape that could not
// grow: every new option would have been another prompt in the chain, and the
// answers to the earlier ones were already forgotten by then.
//
// The format list comes from the exporter REGISTRY, which until now nothing read:
// `registerExporter` had no consumer at all and `dump-export.ts` hard-coded its
// three formats. A format is a plugin again, and the dropdown follows.
//
// Per-format fields come from the element a format names in `ExporterSpec.panel`,
// exactly as an importer names one in `ImporterSpec.panel` for the import dialog.
// The dialog mounts the tag and reads its `value` back, so it needs no import from
// any plugin.

import { LitElement, css, html, nothing } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import type { ExportContext, ExportItem, ExporterSpec, ExportOptions, Table } from '@easydb/shared';
import { ctrlEnterSubmits, dialogChromeStyles, makeDialogDraggable } from '@cawoodm/lit-dialogs';
import { getContext } from '../app-context.js';
import { cachedRowCount } from '../table/row-count-cache.js';
import { DEFAULT_EXPORT_OPTIONS, prepareExport } from '../export/export-rows.js';
import { chooseTables } from './table-select-dialog.js';

/**
 * Rows above which the dialog says what exporting everything costs. The number is
 * the windowing threshold: past it a grid stops holding the table in memory, and
 * an export that reads it whole is doing the thing the grid stopped doing.
 */
const BIG_TABLE_ROWS = 50_000;

/** Open the export dialog. `tableIds` skips the table selector. */
export async function openExport(tableIds?: string[]): Promise<void> {
  const ctx = await getContext();
  let ids = tableIds ?? [];
  if (ids.length === 0) {
    const all = (await ctx.store.tables.find({ workspaceId: ctx.workspaceId })) as Table[];
    if (all.length === 0) {
      ctx.api.ui.dialogs.toast('This workspace has no tables to export.', { kind: 'info', title: 'Export' });
      return;
    }
    if (all.length === 1) {
      ids = [all[0]!.id];
    } else {
      const picked = await chooseTables(
        all.map((t) => ({ name: t.name, size: cachedRowCount(t.id) })),
        { title: 'Export', message: 'Which tables should be exported?', confirmLabel: 'Choose' },
      );
      if (!picked || picked.length === 0) return;
      ids = picked.map((i) => all[i]?.id).filter((v): v is string => !!v);
    }
  }
  const el = ExportDialog.instance ?? mount();
  await el.open(ids);
}

function mount(): ExportDialog {
  const el = document.createElement('export-dialog') as ExportDialog;
  document.body.appendChild(el);
  return el;
}

@customElement('export-dialog')
export class ExportDialog extends LitElement {
  static instance: ExportDialog | null = null;

  static override styles = [
    dialogChromeStyles,
    css`
      dialog {
        min-width: 460px;
        max-width: 640px;
      }
      p.intro {
        margin: 0 0 0.6rem;
        font-size: 0.85rem;
        color: #6b7280;
      }
      .row {
        display: grid;
        grid-template-columns: 7.5rem 1fr;
        align-items: center;
        gap: 0.4rem 0.75rem;
        margin-bottom: 0.4rem;
      }
      .row > label:first-child {
        font-size: 0.85rem;
        color: #374151;
      }
      fieldset {
        border: 1px solid #e5e7eb;
        border-radius: 0.35rem;
        padding: 0.6rem 0.75rem;
        margin: 0 0 0.7rem;
      }
      legend {
        font-size: 0.8rem;
        color: #6b7280;
        padding: 0 0.3rem;
      }
      .choices {
        display: flex;
        gap: 1rem;
        flex-wrap: wrap;
      }
      .choices label,
      .check label {
        display: inline-flex;
        align-items: center;
        gap: 0.3rem;
        font-size: 0.85rem;
      }
      input[type='number'] {
        width: 8rem;
      }
      .hint {
        font-size: 0.78rem;
        color: #6b7280;
      }
      .warn {
        margin: 0.2rem 0 0;
        font-size: 0.8rem;
        color: #92400e;
        background: #fffbeb;
        border: 1px solid #fde68a;
        border-radius: 0.3rem;
        padding: 0.35rem 0.5rem;
      }
      .panel-slot:empty {
        display: none;
      }
    `,
  ];

  @state() private tables: Table[] = [];
  @state() private formats: ExporterSpec[] = [];
  @state() private formatId = '';
  @state() private options: ExportOptions = { ...DEFAULT_EXPORT_OPTIONS };
  @state() private busy = false;
  /** Bumped per open so a format panel is rebuilt rather than reused. */
  @state() private panelGeneration = 0;

  private mountedPanel = '';
  private dialogEl: HTMLDialogElement | null = null;
  private resolveFn: (() => void) | null = null;

  override connectedCallback(): void {
    super.connectedCallback();
    ExportDialog.instance = this;
  }
  override disconnectedCallback(): void {
    super.disconnectedCallback();
    if (ExportDialog.instance === this) ExportDialog.instance = null;
  }

  override firstUpdated(): void {
    this.dialogEl = this.shadowRoot?.querySelector('dialog') ?? null;
    const header = this.shadowRoot?.querySelector('.dialog-header') as HTMLElement | null;
    if (this.dialogEl && header) makeDialogDraggable(this.dialogEl, header);
  }

  async open(tableIds: string[]): Promise<void> {
    const ctx = await getContext();
    const found = await Promise.all(tableIds.map((id) => ctx.store.tables.findOne(id)));
    this.tables = found.filter((t): t is Table => !!t);
    this.formats = [...ctx.registries.exporters].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    if (!this.formats.some((f) => f.id === this.formatId)) this.formatId = this.formats[0]?.id ?? '';
    this.mountedPanel = '';
    this.panelGeneration++;
    this.busy = false;
    return new Promise<void>((resolve) => {
      this.resolveFn = resolve;
      void this.updateComplete.then(() => this.dialogEl?.showModal());
    });
  }

  /**
   * Mount the chosen format's own fields. Done here rather than in `render` because
   * the tag is a string the plugin owns — Lit's `unsafeStatic` would re-create the
   * element on every keystroke, losing what the user typed into it.
   */
  override updated(): void {
    const slot = this.shadowRoot?.querySelector('.panel-slot');
    if (!slot) return;
    const want = this.format()?.panel ?? '';
    const key = `${want}#${this.panelGeneration}`;
    if (this.mountedPanel === key) return;
    this.mountedPanel = key;
    slot.replaceChildren();
    if (want) slot.appendChild(document.createElement(want));
  }

  private format(): ExporterSpec | undefined {
    return this.formats.find((f) => f.id === this.formatId);
  }

  private panelValue(): unknown {
    const el = this.shadowRoot?.querySelector('.panel-slot')?.firstElementChild as { value?: unknown } | null;
    return el?.value;
  }

  private finish(): void {
    this.dialogEl?.close();
    const resolve = this.resolveFn;
    this.resolveFn = null;
    queueMicrotask(() => resolve?.());
  }

  private onCancel = (e: Event): void => {
    e.preventDefault();
    this.finish();
  };

  private set<K extends keyof ExportOptions>(key: K, value: ExportOptions[K]): void {
    this.options = { ...this.options, [key]: value };
  }

  /** Tables big enough that reading them whole is worth a word beforehand. */
  private bigTables(): Array<{ name: string; rows: number }> {
    if (this.options.limitRows > 0) return [];
    return this.tables
      .map((t) => ({ name: t.name, rows: cachedRowCount(t.id) }))
      .filter((t) => t.rows >= BIG_TABLE_ROWS)
      .sort((a, b) => b.rows - a.rows);
  }

  private submit = (e: Event): void => {
    e.preventDefault();
    void this.run();
  };

  private async run(): Promise<void> {
    const spec = this.format();
    if (!spec || this.busy) return;
    this.busy = true;
    const ctx = await getContext();
    const exportCtx: ExportContext = { options: { ...this.options }, panel: this.panelValue(), api: ctx.api };
    try {
      const items: ExportItem[] = [];
      let truncated = false;
      for (const table of this.tables) {
        const prepared = await prepareExport(ctx.store.rows(table.id), table, this.options);
        items.push({ table: prepared.table, rows: prepared.rows });
        truncated ||= prepared.truncated;
      }

      if (items.length > 1 && spec.serializeMany) {
        const body = await spec.serializeMany(items, exportCtx);
        const base = spec.manyBaseName?.(items, exportCtx) ?? `workspace-${ctx.workspaceId}`;
        await ctx.api.backend.saveFile(`${base}${spec.extension}`, body, spec.mimeType ?? mimeFor(spec.extension));
      } else {
        for (const item of items) {
          const body = await spec.serialize(item.table, item.rows, exportCtx);
          await ctx.api.backend.saveFile(`${slug(item.table)}${spec.extension}`, body, spec.mimeType ?? mimeFor(spec.extension));
        }
      }

      if (truncated) {
        ctx.api.ui.dialogs.toast(`The store returned only the first rows of at least one table, so the export is not complete.`, { kind: 'warning', title: 'Export' });
      }
      this.finish();
    } catch (err) {
      ctx.api.ui.dialogs.toast(`Export failed: ${(err as Error)?.message ?? String(err)}`, { kind: 'error', title: 'Export' });
    } finally {
      this.busy = false;
    }
  }

  private renderRadios<K extends keyof ExportOptions>(label: string, key: K, choices: Array<[ExportOptions[K], string]>) {
    return html`
      <div class="row">
        <label>${label}</label>
        <div class="choices">
          ${choices.map(
            ([value, text]) => html`
              <label>
                <input
                  type="radio"
                  name=${String(key)}
                  data-testid=${`export-${String(key)}-${String(value)}`}
                  .checked=${this.options[key] === value}
                  @change=${() => this.set(key, value)}
                />
                ${text}
              </label>
            `,
          )}
        </div>
      </div>
    `;
  }

  override render() {
    const spec = this.format();
    const big = this.bigTables();
    const names = this.tables.map((t) => t.name).join(', ');
    return html`
      <dialog @cancel=${this.onCancel} @keydown=${ctrlEnterSubmits}>
        <button type="button" class="close-x" title="Close" @click=${() => this.finish()}>×</button>
        <form @submit=${this.submit}>
          <div class="dialog-header">
            <h2>Export</h2>
            <div class="header-actions">
              <button type="button" class="ghost" @click=${() => this.finish()}>Cancel</button>
              <button type="submit" class="primary" ?disabled=${this.busy || !spec || this.tables.length === 0} data-testid="export-run">
                ${this.busy ? 'Exporting…' : 'Export'}
              </button>
            </div>
          </div>
          <div class="dialog-body">
            <p class="intro">${this.tables.length === 1 ? html`<strong>${names}</strong>` : html`${this.tables.length} tables: <strong>${names}</strong>`}</p>

            <div class="row">
              <label for="export-format">Format</label>
              <select id="export-format" data-testid="export-format" .value=${this.formatId} @change=${(e: Event) => (this.formatId = (e.target as HTMLSelectElement).value)}>
                ${this.formats.map((f) => html`<option value=${f.id} ?selected=${f.id === this.formatId}>${f.label}</option>`)}
              </select>
            </div>

            <fieldset>
              <legend>General</legend>
              <div class="row">
                <label for="export-limit">Limit rows</label>
                <span>
                  <input
                    id="export-limit"
                    data-testid="export-limit"
                    type="number"
                    min="0"
                    .value=${String(this.options.limitRows)}
                    @input=${(e: Event) => this.set('limitRows', Math.max(0, Number((e.target as HTMLInputElement).value) || 0))}
                  />
                  <span class="hint">0 = all</span>
                </span>
              </div>
              ${this.renderRadios('Columns', 'columns', [
                ['visible', 'Visible'],
                ['all', 'All'],
              ])}
              ${this.renderRadios('Rows', 'rows', [
                ['filtered', 'Filtered'],
                ['unfiltered', 'Unfiltered'],
              ])}
              ${this.renderRadios('Order', 'order', [
                ['sorted', 'Sorted'],
                ['unsorted', 'Unsorted'],
              ])}
              ${this.renderRadios('Values', 'values', [
                ['raw', 'Raw'],
                ['rendered', 'Rendered'],
              ])}
              <div class="row check">
                <label></label>
                <label>
                  <input type="checkbox" data-testid="export-scripts" .checked=${this.options.runScripts} @change=${(e: Event) => this.set('runScripts', (e.target as HTMLInputElement).checked)} />
                  Run scripts
                </label>
              </div>
            </fieldset>

            ${spec?.panel
              ? html`<fieldset>
                  <legend>${spec.label} options</legend>
                  <div class="panel-slot"></div>
                </fieldset>`
              : html`<div class="panel-slot"></div>`}
            ${big.length > 0
              ? html`<p class="warn" data-testid="export-big-warning">
                  ${big.map((t) => `${t.name} has ${t.rows.toLocaleString()} rows`).join('; ')}. Exporting every row reads the whole table into memory — set a limit to write only the first rows.
                </p>`
              : nothing}
          </div>
        </form>
      </dialog>
    `;
  }
}

/** A filename stem for one table, matching what the old export menu wrote. */
function slug(table: Table): string {
  const raw = table.code || table.name || 'table';
  return (
    raw
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'table'
  );
}

/** Last resort when a format named no `mimeType` of its own. */
function mimeFor(extension: string): string {
  if (extension.endsWith('.csv')) return 'text/csv';
  if (extension.endsWith('.sql')) return 'application/sql';
  if (extension.endsWith('.json')) return 'application/json';
  return 'application/octet-stream';
}
