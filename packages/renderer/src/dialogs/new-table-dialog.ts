import { LitElement, css, html } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import type { ColumnSpec, ColumnType, Row, Table } from '@easydb/shared';
import { getContext } from '../app-context.js';
import { materialIconStyles } from '../chrome/material-icon-css.js';
import { makeDialogDraggable } from './draggable.js';
import { ctrlEnterSubmits, dialogChromeStyles } from './dialog-chrome.js';
import { ScriptEditorDialog } from './script-editor-dialog.js';
import { buildColumnSpec, type ColumnRow } from './column-row.js';

const TYPE_OPTIONS: ColumnType[] = ['string', 'number', 'boolean', 'date', 'datetime'];

/**
 * Dual-purpose dialog: creates new tables and edits the columns of existing
 * ones. Open mode is chosen by the optional tableId argument to open().
 *
 * Edit mode keeps existing field names intact by default (renames are
 * destructive — they would require re-keying every row's data object).
 * Renaming is still allowed if you really want it, but the warning text
 * below the columns spells out what happens.
 */
@customElement('new-table-dialog')
export class NewTableDialog extends LitElement {
  static override styles = [
    materialIconStyles,
    dialogChromeStyles,
    css`
      dialog {
        max-width: 96vw;
        width: 1180px;
      }
      label {
        display: flex;
        flex-direction: column;
        gap: 0.25rem;
        font-size: 0.85rem;
        color: #374151;
      }
      input,
      select {
        font: inherit;
        padding: 0.4rem 0.5rem;
        border: 1px solid #d1d5db;
        border-radius: 0.25rem;
      }
      .columns {
        display: grid;
        gap: 0.5rem;
      }
      .col-header,
      .col-row {
        display: grid;
        grid-template-columns: 1.25rem 1fr 1fr 7rem 7rem 1.5rem 4rem 1.5rem 1.5rem 1.5rem 1.5rem 1.5rem 1.5rem;
        gap: 0.4rem;
        align-items: center;
      }
      .drag-handle {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        color: #9ca3af;
        cursor: grab;
        user-select: none;
      }
      .drag-handle:active {
        cursor: grabbing;
      }
      .drag-handle:hover {
        color: #374151;
      }
      .col-row.drag-source {
        opacity: 0.4;
      }
      .col-row.drop-before {
        box-shadow: inset 0 3px 0 #3b82f6;
      }
      .col-row.drop-after {
        box-shadow: inset 0 -3px 0 #3b82f6;
      }
      .col-row input[type='number'] {
        width: 100%;
        box-sizing: border-box;
      }
      .col-row .flag {
        display: inline-flex;
        justify-content: center;
      }
      .col-header .flag-label {
        font-size: 0.7rem;
        text-align: center;
      }
      .col-header {
        font-size: 0.75rem;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        color: #6b7280;
      }
      button.icon-btn {
        background: transparent;
        border: 0;
        color: #6b7280;
        cursor: pointer;
        padding: 0;
        font-size: 1rem;
      }
      button.icon-btn:hover:not(:disabled) {
        color: #111827;
      }
      button.icon-btn:disabled {
        color: #d1d5db;
        cursor: not-allowed;
      }
      /* A column that already carries a script — blue so it is obvious which
       columns are computed without opening each editor. The glyph itself
       never changes (always the pencil); colour alone carries the state. */
      button.icon-btn.has-script {
        color: #2563eb;
      }
      /* Without this, the plain :hover rule above (color: #111827) would win
       and a script-set pencil would go near-black on hover, losing the blue
       state cue. A darker blue keeps hover feedback without discarding it. */
      button.icon-btn.has-script:hover:not(:disabled) {
        color: #1d4ed8;
      }
      button.row-del {
        color: #9ca3af;
        font-size: 1.1rem;
      }
      button.row-del:hover:not(:disabled) {
        color: #ef4444;
      }
      button.add {
        align-self: start;
        background: #f3f4f6;
        border: 1px dashed #9ca3af;
        padding: 0.4rem 0.75rem;
        border-radius: 0.25rem;
        cursor: pointer;
      }
      .error {
        color: #ef4444;
        font-size: 0.85rem;
      }
      .notice {
        background: #fef9c3;
        border: 1px solid #fde047;
        color: #713f12;
        border-radius: 0.35rem;
        padding: 0.45rem 0.6rem;
        font-size: 0.85rem;
        margin-bottom: 0.6rem;
      }
      .hint {
        color: #6b7280;
        font-size: 0.78rem;
      }
      .mi.sm {
        font-size: 0.95rem;
      }
      /* Live preview table: shows the first 100 rows so the user can see
       which cells would fail validation under the edited column specs. */
      .preview {
        border-top: 1px solid #e5e7eb;
        margin-top: 0.5rem;
        max-height: 36vh;
        overflow: auto;
      }
      .preview h3 {
        margin: 0;
        padding: 0.6rem 0.4rem 0.4rem;
        font-size: 0.85rem;
        color: #6b7280;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.04em;
      }
      .preview table {
        width: 100%;
        border-collapse: collapse;
        font-size: 0.8rem;
      }
      .preview th,
      .preview td {
        border: 1px solid #e5e7eb;
        padding: 0.2rem 0.4rem;
        text-align: left;
        vertical-align: top;
        white-space: nowrap;
        max-width: 18rem;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .preview th {
        background: #f9fafb;
        position: sticky;
        top: 0;
        z-index: 1;
      }
      .preview td.violation {
        background: #fee2e2;
        color: #991b1b;
      }
      .preview .empty {
        padding: 0.75rem 0.4rem;
        color: #9ca3af;
        font-style: italic;
      }
    `,
  ];

  @state() private mode: 'new' | 'edit' = 'new';
  @state() private editTableId: string | null = null;
  @state() private name = '';
  @state() private tableTitle = '';
  @state() private columns: ColumnRow[] = [];
  @state() private errorMsg = '';
  /** Non-error banner (e.g. "a refresh found new columns — review them"). */
  @state() private noticeMsg = '';
  @state() private dragSrcIdx: number | null = null;
  @state() private dropTargetIdx: number | null = null;
  @state() private dropEdge: 'before' | 'after' | null = null;
  /** First 100 rows of the table being edited; populated only in edit mode. */
  @state() private previewRows: Row[] = [];
  /**
   * Snapshot of renderer names registered at open time. Populated from
   * `registries.cellRenderers` keys; built-in renderers (date, datetime,
   * boolean, color, image, link) and any plugin-registered ones land here.
   */
  @state() private rendererOptions: string[] = [];
  private rendererSubUnsub?: (() => void) | undefined;

  private dialogEl: HTMLDialogElement | null = null;

  override firstUpdated() {
    this.dialogEl = this.shadowRoot?.querySelector('dialog') ?? null;
    const header = this.shadowRoot?.querySelector('.dialog-header') as HTMLElement | null;
    if (this.dialogEl && header) makeDialogDraggable(this.dialogEl, header);
  }

  /**
   * Open the dialog. If tableId is provided, opens in "edit" mode and pre-fills
   * the form from the saved Table. Otherwise opens "new" mode with two default
   * string columns.
   */
  async open(tableId?: string, opts?: { notice?: string | undefined }): Promise<void> {
    this.errorMsg = '';
    this.noticeMsg = opts?.notice ?? '';
    // Snapshot the currently registered cell renderers and keep them fresh
    // while the dialog is open — a plugin install after dialog open should
    // surface its renderer too. The unsub fires on close().
    const ctxForRenderers = await getContext();
    this.rendererOptions = [...ctxForRenderers.registries.cellRenderers.keys()].sort();
    this.rendererSubUnsub?.();
    this.rendererSubUnsub = ctxForRenderers.events.on('app:ready', () => {
      this.rendererOptions = [...ctxForRenderers.registries.cellRenderers.keys()].sort();
    });
    if (tableId) {
      const ctx = await getContext();
      const t = await ctx.store.tables.findOne(tableId);
      if (!t) return;
      this.mode = 'edit';
      this.editTableId = tableId;
      this.name = t.name;
      this.tableTitle = t.title ?? '';
      this.columns = t.columns.map((c) => ({
        field: c.field,
        label: c.label,
        type: c.type,
        renderer: c.renderer,
        script: c.script,
        max: c.max,
        unique: c.unique,
        notnull: c.notnull,
        hidden: c.hidden,
        origField: c.field,
        orig: c,
      }));
      // Pull the first 100 rows for the live preview. We deliberately don't
      // subscribe — the dialog is short-lived and external row edits during
      // the dialog session are rare enough that a snapshot is fine.
      const allRows = await ctx.store.rows(tableId).find();
      this.previewRows = allRows.slice(0, 100);
    } else {
      this.mode = 'new';
      this.editTableId = null;
      this.name = '';
      this.tableTitle = '';
      this.columns = [
        { field: 'name', label: 'Name', type: 'string' },
        { field: 'note', label: 'Note', type: 'string' },
      ];
      this.previewRows = [];
    }
    await this.updateComplete;
    this.dialogEl?.showModal();
  }

  private close(): void {
    this.dialogEl?.close();
    this.rendererSubUnsub?.();
    this.rendererSubUnsub = undefined;
  }

  private addColumn(): void {
    const i = this.columns.length + 1;
    this.columns = [...this.columns, { field: `field_${i}`, label: `Field ${i}`, type: 'string' }];
  }

  private removeColumn(idx: number): void {
    this.columns = this.columns.filter((_, i) => i !== idx);
  }

  private moveColumn(idx: number, delta: -1 | 1): void {
    const j = idx + delta;
    if (j < 0 || j >= this.columns.length) return;
    const next = [...this.columns];
    const [item] = next.splice(idx, 1);
    next.splice(j, 0, item!);
    this.columns = next;
  }

  private onRowDragStart(e: DragEvent, idx: number) {
    this.dragSrcIdx = idx;
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/x-easydb-coleditor-row', String(idx));
    }
  }

  private onRowDragOver(e: DragEvent, idx: number, row: HTMLElement) {
    if (this.dragSrcIdx === null || this.dragSrcIdx === idx) return;
    e.preventDefault();
    const rect = row.getBoundingClientRect();
    const before = e.clientY < rect.top + rect.height / 2;
    this.dropTargetIdx = idx;
    this.dropEdge = before ? 'before' : 'after';
  }

  private onRowDragLeave(idx: number) {
    if (this.dropTargetIdx === idx) {
      this.dropTargetIdx = null;
      this.dropEdge = null;
    }
  }

  private onRowDrop(e: DragEvent, targetIdx: number) {
    e.preventDefault();
    const src = this.dragSrcIdx;
    const edge = this.dropEdge;
    this.dragSrcIdx = null;
    this.dropTargetIdx = null;
    this.dropEdge = null;
    if (src === null || src === targetIdx || !edge) return;

    const next = [...this.columns];
    const [moved] = next.splice(src, 1);
    // After splice, the target index shifts left by 1 when src < target.
    let toIdx = targetIdx + (src < targetIdx ? -1 : 0);
    if (edge === 'after') toIdx += 1;
    next.splice(toIdx, 0, moved!);
    this.columns = next;
  }

  private onRowDragEnd() {
    this.dragSrcIdx = null;
    this.dropTargetIdx = null;
    this.dropEdge = null;
  }

  private patchColumn(idx: number, patch: Partial<ColumnRow>): void {
    this.columns = this.columns.map((c, i) => (i === idx ? { ...c, ...patch } : c));
  }

  /**
   * Open the script-editor modal for the column at `idx`. Resolves to a
   * patched column row (or no-op on cancel). The dialog is mounted as a
   * sibling of this dialog in `<app-shell>`'s shadow root, so the static
   * `ScriptEditorDialog.instance` accessor is how we reach it without
   * leaking a query selector across shadow boundaries.
   */
  private async editScript(idx: number): Promise<void> {
    const dlg = ScriptEditorDialog.instance;
    if (!dlg) return;
    const c = this.columns[idx];
    if (!c) return;
    const next = await dlg.open(c.script ?? '', c.label || c.field);
    if (next === null) return;
    this.patchColumn(idx, { script: next.trim() ? next : undefined });
  }

  private async submit(e: Event): Promise<void> {
    e.preventDefault();
    const name = this.name.trim();
    if (!name) {
      this.errorMsg = 'Table name is required.';
      return;
    }
    const ctx = await getContext();
    const workspaceTables = (await ctx.store.tables.find()).filter(
      (t) => t.workspaceId === ctx.workspaceId,
    );
    const lowerName = name.toLowerCase();
    const clash = workspaceTables.find(
      (t) => t.name.toLowerCase() === lowerName && t.id !== this.editTableId,
    );
    if (clash) {
      this.errorMsg = `A table named "${clash.name}" already exists — names must be unique.`;
      return;
    }
    if (this.columns.length === 0) {
      this.errorMsg = 'At least one column is required.';
      return;
    }
    const seen = new Set<string>();
    for (const c of this.columns) {
      const f = c.field.trim();
      if (!f) {
        this.errorMsg = 'Column field names cannot be empty.';
        return;
      }
      if (seen.has(f)) {
        this.errorMsg = `Duplicate column field: ${f}`;
        return;
      }
      seen.add(f);
    }

    const title = this.tableTitle.trim();
    // buildColumnSpec spreads each row's `orig` ColumnSpec (when hydrated from
    // a saved table) as the base, so fields the editor doesn't own — default,
    // width, description, units, sortable — survive the save instead of being
    // dropped. See column-row.ts for why clearing a field must explicitly
    // delete it rather than just skip setting it.
    const columns: ColumnSpec[] = this.columns.map(buildColumnSpec);

    if (this.mode === 'edit' && this.editTableId) {
      // Pre-flight scan: if any column has just been flagged unique or notnull
      // and the existing rows would violate it, block the save with a list of
      // offending row indices so the user can fix the data first.
      const tableId = this.editTableId;
      const existingTable = await ctx.store.tables.findOne(tableId);
      const prevSpecs = new Map((existingTable?.columns ?? []).map((c) => [c.field, c]));
      const newConstraints = columns.filter((c) => {
        const prev = prevSpecs.get(c.field);
        return (
          (c.unique && !prev?.unique) ||
          (c.notnull && !prev?.notnull) ||
          (c.max && c.max > 0 && c.max !== prev?.max)
        );
      });
      if (newConstraints.length > 0) {
        const rows = await ctx.store.rows(tableId).find();
        const violations = scanConstraintViolations(newConstraints, rows);
        if (violations.length > 0) {
          this.errorMsg = `Cannot save: ${violations.length} existing ${
            violations.length === 1 ? 'row violates' : 'rows violate'
          } the new constraints.\n${violations.slice(0, 5).join('\n')}${
            violations.length > 5 ? `\n…and ${violations.length - 5} more.` : ''
          }`;
          return;
        }
      }
      // Track columns the user removed so a later re-import / refresh doesn't
      // re-add them. A removed column is an original field no longer kept by any
      // row (renames keep their `origField`, so they don't count as deleted).
      // Re-adding a column with a previously-deleted name clears it from the set.
      const keptOrig = new Set(
        this.columns.map((c) => c.origField).filter((f): f is string => !!f),
      );
      const savedFields = new Set(columns.map((c) => c.field));
      const removedNow = (existingTable?.columns ?? [])
        .map((c) => c.field)
        .filter((f) => !keptOrig.has(f));
      const prevDeleted = existingTable?.deletedColumns ?? [];
      const deletedColumns = [...new Set([...prevDeleted, ...removedNow])].filter(
        (f) => !savedFields.has(f),
      );

      // Patch the saved table; row data isn't migrated. If a field was
      // renamed, downstream cells will read undefined and display as empty.
      const patch: Partial<Table> = { name, title, columns, updatedAt: Date.now() };
      // Only persist the deleted-columns list when it carries meaning (there's
      // something tracked, or we're clearing a previously-tracked set).
      if (deletedColumns.length > 0 || prevDeleted.length > 0) {
        patch.deletedColumns = deletedColumns;
      }
      const oldName = existingTable?.name;
      await ctx.store.tables.patch(tableId, patch);

      // Scrub the data of genuinely-deleted columns from every row: deleted
      // columns must not be stored, synced, or persisted — only their name is
      // remembered (in `deletedColumns`) so a refresh/re-import won't re-add
      // them. Renamed columns keep their `origField`, so they're excluded here;
      // only true deletions are purged. Skip rows that carry none of the fields.
      const purgeFields = removedNow.filter((f) => !savedFields.has(f));
      if (purgeFields.length > 0) {
        const rows = await ctx.store.rows(tableId).find();
        for (const r of rows) {
          let touched = false;
          const data = { ...r.data };
          for (const f of purgeFields) {
            if (f in data) {
              delete data[f];
              touched = true;
            }
          }
          if (touched) {
            await ctx.store.rows(tableId).patch(r.id, { data, updatedAt: Date.now() });
          }
        }
      }
      // Keep dependent view instances connected: a closed view snapshot its
      // source table's name at creation time, so a rename must propagate or
      // the view would silently point at a stale name.
      if (oldName !== undefined && oldName !== name) {
        const insts = (await ctx.store.viewInstances.find()).filter((vi) => vi.tableId === tableId);
        for (const vi of insts) {
          if (vi.tableName !== name) {
            await ctx.store.viewInstances.patch(vi.id, { tableName: name, updatedAt: Date.now() });
          }
        }
      }
    } else {
      await ctx.store.tables.insert({
        id: cryptoUUID(),
        workspaceId: ctx.workspaceId,
        name,
        title,
        code: slug(name),
        columns,
        view: 'table',
        updatedAt: Date.now(),
      });
    }
    this.close();
  }

  private renderPreview() {
    if (this.previewRows.length === 0) {
      return html`<div class="preview"><div class="empty">No rows to preview.</div></div>`;
    }
    // Precompute duplicate maps for any unique column so per-row checks are O(1).
    const duplicateSets = new Map<string, Set<unknown>>();
    for (const c of this.columns) {
      if (!c.unique) continue;
      const seen = new Set<unknown>();
      const dups = new Set<unknown>();
      for (const r of this.previewRows) {
        const v = r.data[c.field];
        if (v == null || v === '') continue;
        if (seen.has(v)) dups.add(v);
        seen.add(v);
      }
      duplicateSets.set(c.field, dups);
    }
    // Mirror the real grid: hidden columns are excluded from the preview.
    const visible = this.columns.filter((c) => !c.hidden);
    return html`
      <div class="preview">
        <h3>
          Live preview — first ${this.previewRows.length}
          row${this.previewRows.length === 1 ? '' : 's'}
        </h3>
        <table>
          <thead>
            <tr>
              ${visible.map((c) => html`<th title=${c.field}>${c.label || c.field}</th>`)}
            </tr>
          </thead>
          <tbody>
            ${this.previewRows.map(
              (r) => html`
                <tr>
                  ${visible.map((c) => {
                    const v = r.data[c.field];
                    const reason = validateAgainstSpec(c, v, duplicateSets.get(c.field));
                    return html`<td class=${reason ? 'violation' : ''} title=${reason ?? ''}>
                      ${formatPreview(v)}
                    </td>`;
                  })}
                </tr>
              `,
            )}
          </tbody>
        </table>
      </div>
    `;
  }

  private renameDetected(): boolean {
    return (
      this.mode === 'edit' &&
      this.columns.some((c) => c.origField && c.origField !== c.field.trim())
    );
  }

  override render() {
    const title = this.mode === 'edit' ? 'Edit columns' : 'New table';
    const submitLabel = this.mode === 'edit' ? 'Save' : 'Create';
    return html`
      <dialog @cancel=${this.close} @keydown=${ctrlEnterSubmits}>
        <button type="button" class="close-x" title="Close" @click=${this.close}>
          <span class="mi sm">close</span>
        </button>
        <form @submit=${this.submit}>
          <div class="dialog-header">
            <h2>${title}</h2>
            <div class="header-actions">
              <button type="button" class="ghost" @click=${this.close}>Cancel</button>
              <button type="submit" class="primary">${submitLabel}</button>
            </div>
          </div>
          <div class="dialog-body">
            ${this.noticeMsg ? html`<div class="notice">${this.noticeMsg}</div>` : ''}
            <label>
              Name
              <input
                type="text"
                autofocus
                .value=${this.name}
                @input=${(e: Event) => (this.name = (e.target as HTMLInputElement).value)}
              />
            </label>
            <label>
              Title <span style="color:#9ca3af">(optional — shown in the window title)</span>
              <input
                type="text"
                .value=${this.tableTitle}
                @input=${(e: Event) => (this.tableTitle = (e.target as HTMLInputElement).value)}
              />
            </label>

            <div class="columns">
              <div class="col-header">
                <span></span>
                <span>Field</span>
                <span>Label</span>
                <span>Type</span>
                <span>Renderer</span>
                <span></span>
                <span class="flag-label">Max</span>
                <span class="flag-label" title="Unique">U</span>
                <span class="flag-label" title="Not null">!</span>
                <span class="flag-label" title="Visible">👁</span>
                <span></span>
                <span></span>
                <span></span>
              </div>
              ${this.columns.map((c, i) => {
                const isSrc = this.dragSrcIdx === i;
                const isTgt = this.dropTargetIdx === i;
                const edgeClass =
                  isTgt && this.dropEdge === 'before'
                    ? ' drop-before'
                    : isTgt && this.dropEdge === 'after'
                      ? ' drop-after'
                      : '';
                return html`
                  <div
                    class=${`col-row${isSrc ? ' drag-source' : ''}${edgeClass}`}
                    @dragover=${(e: DragEvent) =>
                      this.onRowDragOver(e, i, e.currentTarget as HTMLElement)}
                    @dragleave=${() => this.onRowDragLeave(i)}
                    @drop=${(e: DragEvent) => this.onRowDrop(e, i)}
                  >
                    <span
                      class="drag-handle"
                      title="Drag to reorder"
                      draggable="true"
                      @dragstart=${(e: DragEvent) => this.onRowDragStart(e, i)}
                      @dragend=${() => this.onRowDragEnd()}
                    >
                      <span class="mi sm">drag_indicator</span>
                    </span>
                    <input
                      type="text"
                      .value=${c.field}
                      @input=${(e: Event) =>
                        this.patchColumn(i, { field: (e.target as HTMLInputElement).value })}
                    />
                    <input
                      type="text"
                      .value=${c.label}
                      @input=${(e: Event) =>
                        this.patchColumn(i, { label: (e.target as HTMLInputElement).value })}
                    />
                    <select
                      .value=${c.type}
                      @change=${(e: Event) =>
                        this.patchColumn(i, {
                          type: (e.target as HTMLSelectElement).value as ColumnType,
                        })}
                    >
                      ${TYPE_OPTIONS.map(
                        (t) => html`<option value=${t} ?selected=${t === c.type}>${t}</option>`,
                      )}
                    </select>
                    <select
                      title="Renderer — how cells in this column display. Read-only HTML-encoded text when blank."
                      .value=${c.renderer ?? ''}
                      @change=${(e: Event) => {
                        const v = (e.target as HTMLSelectElement).value;
                        this.patchColumn(i, { renderer: v || undefined });
                      }}
                    >
                      <option value="" ?selected=${!c.renderer}>— none —</option>
                      ${this.rendererOptions.map(
                        (r) => html`<option value=${r} ?selected=${r === c.renderer}>${r}</option>`,
                      )}
                    </select>
                    <button
                      type="button"
                      class=${`icon-btn${c.script?.trim() ? ' has-script' : ''}`}
                      title=${c.script?.trim()
                        ? 'Edit the script — its render(row) output is what this column displays'
                        : 'Add a script: render(row) computes what this column displays'}
                      @click=${() => this.editScript(i)}
                    >
                      <span class="mi sm">edit</span>
                    </button>
                    <input
                      type="number"
                      min="0"
                      placeholder="—"
                      title="Max length (strings) or max value (numbers)"
                      .value=${c.max == null ? '' : String(c.max)}
                      @input=${(e: Event) => {
                        const v = (e.target as HTMLInputElement).value;
                        this.patchColumn(i, { max: v === '' ? undefined : Number(v) });
                      }}
                    />
                    <span class="flag">
                      <input
                        type="checkbox"
                        title="Unique"
                        .checked=${!!c.unique}
                        @change=${(e: Event) =>
                          this.patchColumn(i, { unique: (e.target as HTMLInputElement).checked })}
                      />
                    </span>
                    <span class="flag">
                      <input
                        type="checkbox"
                        title="Not null"
                        .checked=${!!c.notnull}
                        @change=${(e: Event) =>
                          this.patchColumn(i, { notnull: (e.target as HTMLInputElement).checked })}
                      />
                    </span>
                    <span class="flag">
                      <input
                        type="checkbox"
                        title="Visible — uncheck to hide the column without losing its data"
                        .checked=${!c.hidden}
                        @change=${(e: Event) =>
                          this.patchColumn(i, { hidden: !(e.target as HTMLInputElement).checked })}
                      />
                    </span>
                    <button
                      type="button"
                      class="icon-btn"
                      title="Move up"
                      ?disabled=${i === 0}
                      @click=${() => this.moveColumn(i, -1)}
                    >
                      <span class="mi sm">arrow_upward</span>
                    </button>
                    <button
                      type="button"
                      class="icon-btn"
                      title="Move down"
                      ?disabled=${i === this.columns.length - 1}
                      @click=${() => this.moveColumn(i, 1)}
                    >
                      <span class="mi sm">arrow_downward</span>
                    </button>
                    <button
                      type="button"
                      class="icon-btn row-del"
                      title="Remove column"
                      @click=${() => this.removeColumn(i)}
                    >
                      <span class="mi sm">delete</span>
                    </button>
                  </div>
                `;
              })}
            </div>

            <button type="button" class="add" @click=${this.addColumn}>+ Add column</button>

            ${this.renameDetected()
              ? html`<div class="hint">
                  Renamed fields will appear empty for existing rows — the row data isn't migrated
                  automatically.
                </div>`
              : ''}
            ${this.errorMsg ? html`<div class="error">${this.errorMsg}</div>` : ''}
            ${this.mode === 'edit' ? this.renderPreview() : ''}
          </div>
        </form>
      </dialog>
    `;
  }
}

function formatPreview(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  return String(v);
}

/**
 * Inline cell validation against a single (in-progress) ColumnRow spec.
 * Powers the live preview: returns a short human reason when the cell
 * would fail, or null when it's fine. `dupSet` is the set of values seen
 * more than once across the preview slice for unique columns.
 */
function validateAgainstSpec(
  c: ColumnRow,
  v: unknown,
  dupSet: Set<unknown> | undefined,
): string | null {
  const empty = v === null || v === undefined || (typeof v === 'string' && v.trim() === '');
  if (c.notnull && empty) return `${c.label}: empty`;
  if (empty) return null;
  if (c.type === 'number' && typeof v !== 'number') {
    const n = Number(v);
    if (!Number.isFinite(n)) return `${c.label}: not a number`;
  }
  if (c.type === 'boolean' && typeof v !== 'boolean') {
    if (!/^(true|false|yes|no|0|1)$/i.test(String(v))) return `${c.label}: not boolean`;
  }
  if ((c.type === 'date' || c.type === 'datetime') && !empty) {
    const d = new Date(String(v));
    if (Number.isNaN(d.getTime())) return `${c.label}: not a date`;
  }
  if (c.max != null && c.max > 0) {
    if (typeof v === 'string' && v.length > c.max) return `${c.label}: length > ${c.max}`;
    if (typeof v === 'number' && v > c.max) return `${c.label}: > ${c.max}`;
  }
  if (c.unique && dupSet?.has(v)) return `${c.label}: duplicate`;
  return null;
}

/**
 * Returns a list of "Row N: <reason>" strings for any row that violates one
 * of the supplied (presumed newly-enabled) constraints. Empty list means
 * the constraints can be applied cleanly.
 */
function scanConstraintViolations(specs: ColumnSpec[], rows: Row[]): string[] {
  const out: string[] = [];
  for (const c of specs) {
    if (c.notnull) {
      rows.forEach((r, i) => {
        const v = r.data[c.field];
        if (v === null || v === undefined || (typeof v === 'string' && v.trim() === '')) {
          out.push(`Row ${i + 1}: ${c.label} is empty.`);
        }
      });
    }
    if (c.max != null && c.max > 0) {
      rows.forEach((r, i) => {
        const v = r.data[c.field];
        if (typeof v === 'string' && v.length > c.max!) {
          out.push(`Row ${i + 1}: ${c.label} length ${v.length} > max ${c.max}.`);
        } else if (typeof v === 'number' && v > c.max!) {
          out.push(`Row ${i + 1}: ${c.label} value ${v} > max ${c.max}.`);
        }
      });
    }
    if (c.unique) {
      const seen = new Map<unknown, number>();
      rows.forEach((r, i) => {
        const v = r.data[c.field];
        if (v === null || v === undefined || v === '') return;
        if (seen.has(v)) {
          out.push(`Row ${i + 1}: ${c.label} duplicates row ${seen.get(v)! + 1} ("${String(v)}").`);
        } else {
          seen.set(v, i);
        }
      });
    }
  }
  return out;
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

function cryptoUUID(): string {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
  );
}

declare global {
  interface HTMLElementTagNameMap {
    'new-table-dialog': NewTableDialog;
  }
}
