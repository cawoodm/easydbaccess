import { LitElement, css, html, nothing } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import type { ColumnSpec, Table, ViewInstance, ViewTemplate } from '@easydb/shared';
import { getContext } from '../app-context.js';
import { ctrlEnterSubmits, dialogChromeStyles } from './dialog-chrome.js';
import { makeDialogDraggable } from './draggable.js';
import { extractTokens } from '../views/view-render.js';

/**
 * Open the Views manager for a table (mounted lazily into <body>). Pass
 * `editTemplateId` to jump straight into editing that template, or
 * `editInstanceId` to jump into editing that view instance (rename / re-map) —
 * both used by the icon buttons in a view window's footer.
 */
export function openViewsDialog(
  tableId: string,
  opts?: { editTemplateId?: string; editInstanceId?: string },
): void {
  const dlg = ViewsDialog.instance ?? mount();
  void dlg.open(tableId, opts);
}

function mount(): ViewsDialog {
  const el = document.createElement('views-dialog') as ViewsDialog;
  document.body.appendChild(el);
  return el;
}

function uuid(): string {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
  );
}

interface TemplateDraft {
  id: string | null; // null ⇒ new
  name: string;
  headerHtml: string;
  rowHtml: string;
  footerHtml: string;
}

interface InstanceDraft {
  id: string | null; // null ⇒ new instance
  templateId: string;
  templateName: string;
  name: string;
  tokens: string[];
  mapping: Record<string, string>;
  limit: number; // 0 = all
  readonly: boolean; // grid (template-off) view shows values with no editors
}

@customElement('views-dialog')
export class ViewsDialog extends LitElement {
  static instance: ViewsDialog | null = null;

  static override styles = [
    dialogChromeStyles,
    css`
      dialog {
        min-width: 520px;
        max-width: 680px;
      }
      h3 {
        margin: 0 0 0.4rem;
        font-size: 0.9rem;
        color: #374151;
      }
      .section {
        display: flex;
        flex-direction: column;
        gap: 0.4rem;
      }
      ul.list {
        list-style: none;
        margin: 0;
        padding: 0;
        border: 1px solid #e5e7eb;
        border-radius: 0.35rem;
        max-height: 30vh;
        overflow: auto;
      }
      ul.list:empty::after {
        content: 'None yet.';
        display: block;
        padding: 0.5rem 0.7rem;
        color: #9ca3af;
        font-size: 0.85rem;
      }
      li {
        display: flex;
        align-items: center;
        gap: 0.5rem;
        padding: 0.4rem 0.6rem;
        border-bottom: 1px solid #f1f5f9;
      }
      li:last-child {
        border-bottom: 0;
      }
      li .name {
        flex: 1;
        font-weight: 500;
        color: #111827;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .badge {
        font-size: 0.7rem;
        color: #6b7280;
        border: 1px solid #d1d5db;
        border-radius: 0.6rem;
        padding: 0 0.4rem;
      }
      button.mini {
        font: inherit;
        font-size: 0.8rem;
        padding: 0.15rem 0.5rem;
        border: 1px solid #d1d5db;
        background: white;
        border-radius: 0.25rem;
        cursor: pointer;
      }
      button.mini:hover {
        background: #f3f4f6;
      }
      button.mini.danger {
        color: #b91c1c;
        border-color: #fecaca;
      }
      label.field {
        display: flex;
        flex-direction: column;
        gap: 0.25rem;
        font-size: 0.82rem;
        color: #374151;
      }
      label.field-inline {
        display: flex;
        flex-direction: row;
        align-items: center;
        gap: 0.4rem;
        font-size: 0.82rem;
        color: #374151;
      }
      input[type='text'],
      textarea,
      select {
        font: inherit;
        padding: 0.4rem 0.5rem;
        border: 1px solid #d1d5db;
        border-radius: 0.25rem;
        width: 100%;
        box-sizing: border-box;
      }
      textarea {
        font-family: ui-monospace, SFMono-Regular, monospace;
        font-size: 0.8rem;
        min-height: 4.5rem;
        resize: vertical;
      }
      .hint {
        color: #6b7280;
        font-size: 0.78rem;
        margin: 0;
      }
      .map-row {
        display: grid;
        grid-template-columns: 8rem 1fr;
        align-items: center;
        gap: 0.5rem;
      }
      .map-row code {
        font-family: ui-monospace, SFMono-Regular, monospace;
        color: #2563eb;
      }
    `,
  ];

  @state() private mode: 'list' | 'template' | 'instance' = 'list';
  @state() private instances: ViewInstance[] = [];
  @state() private templates: ViewTemplate[] = [];
  @state() private tDraft: TemplateDraft | null = null;
  @state() private iDraft: InstanceDraft | null = null;

  private tableId = '';
  private table: Table | null = null;
  private columns: ColumnSpec[] = [];
  private dialogEl: HTMLDialogElement | null = null;

  override connectedCallback(): void {
    super.connectedCallback();
    ViewsDialog.instance = this;
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    if (ViewsDialog.instance === this) ViewsDialog.instance = null;
  }

  override firstUpdated(): void {
    this.dialogEl = this.shadowRoot?.querySelector('dialog') ?? null;
    const header = this.shadowRoot?.querySelector('.dialog-header') as HTMLElement | null;
    if (this.dialogEl && header) makeDialogDraggable(this.dialogEl, header);
  }

  async open(
    tableId: string,
    opts?: { editTemplateId?: string; editInstanceId?: string },
  ): Promise<void> {
    this.tableId = tableId;
    this.mode = 'list';
    this.tDraft = null;
    this.iDraft = null;
    await this.refresh();
    // Deep-link straight into a template or instance editor (from a view
    // window's footer icons).
    if (opts?.editTemplateId) {
      const t = this.templates.find((x) => x.id === opts.editTemplateId);
      if (t) this.editTemplate(t);
    } else if (opts?.editInstanceId) {
      const inst = this.instances.find((x) => x.id === opts.editInstanceId);
      if (inst) await this.editInstance(inst);
    }
    await this.updateComplete;
    this.dialogEl?.showModal();
  }

  private async refresh(): Promise<void> {
    const ctx = await getContext();
    const wsId = ctx.workspaceId;
    this.table = await ctx.store.tables.findOne(this.tableId);
    this.columns = this.table?.columns ?? [];
    this.instances = (await ctx.store.viewInstances.find({ workspaceId: wsId })).filter(
      (v) => v.tableId === this.tableId,
    );
    this.templates = (await ctx.store.viewTemplates.find({ workspaceId: wsId })).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
  }

  private close = (): void => {
    this.dialogEl?.close();
  };

  // The form's one submit path: Enter/Ctrl+Enter or clicking the primary
  // button all route here, dispatching to whichever action is primary for
  // the current mode (mirrors the header-actions button below).
  private onSubmit = (e: Event): void => {
    e.preventDefault();
    if (this.mode === 'template') void this.saveTemplate();
    else if (this.mode === 'instance') void this.saveInstance();
    else this.close();
  };

  // -- instances --------------------------------------------------------------

  private async openInstance(id: string): Promise<void> {
    // Flip the persisted `open` flag; the core view-window manager reacts by
    // opening (and later restoring) the window. The dialog owns intent, not
    // window management.
    const ctx = await getContext();
    await ctx.store.viewInstances.patch(id, { open: true, updatedAt: Date.now() });
    this.close();
  }

  /** Edit an existing instance: rename it and/or re-map its template tokens. */
  private async editInstance(inst: ViewInstance): Promise<void> {
    const ctx = await getContext();
    const tpl = await ctx.store.viewTemplates.findOne(inst.templateId);
    // Recover the template's live tokens; fall back to whatever the instance
    // already mapped if the template is gone.
    const tokens = tpl
      ? extractTokens(tpl.headerHtml, tpl.rowHtml, tpl.footerHtml)
      : Object.keys(inst.mapping);
    this.iDraft = {
      id: inst.id,
      templateId: inst.templateId,
      templateName: tpl?.name ?? 'template',
      name: inst.name,
      tokens,
      mapping: { ...inst.mapping },
      limit: inst.limit ?? 0,
      readonly: inst.readonly ?? false,
    };
    this.mode = 'instance';
  }

  private async deleteInstance(id: string): Promise<void> {
    const ctx = await getContext();
    await ctx.store.viewInstances.remove(id);
    // The core view-window manager closes the window when its instance vanishes
    // from the reconcile subscription — no explicit close event needed.
    await this.refresh();
  }

  /**
   * Duplicate a view, RE-SNAPSHOTTING the table's current columns. A view's
   * `visibleColumns` is frozen at creation, so columns added to the table later
   * never appear in it. Copying picks up the current schema (new columns
   * included) while keeping the template, token mapping, filters, sort and other
   * options. Lands closed in the list so the user can open or tweak it. */
  private async copyInstance(inst: ViewInstance): Promise<void> {
    const ctx = await getContext();
    // Current, non-hidden columns — same rule new views use (see saveInstance).
    const visibleColumns = this.columns.filter((c) => !c.hidden).map((c) => c.field);
    const copy: ViewInstance = {
      ...inst,
      id: uuid(),
      name: `${inst.name} copy`,
      visibleColumns,
      open: false, // don't auto-open; it shows in the list to open/edit
      windowGeometry: undefined, // fresh position, not stacked on the original
      updatedAt: Date.now(),
    };
    await ctx.store.viewInstances.insert(copy);
    await this.refresh();
  }

  // -- templates --------------------------------------------------------------

  private newTemplate(): void {
    this.tDraft = { id: null, name: '', headerHtml: '', rowHtml: '', footerHtml: '' };
    this.mode = 'template';
  }

  private editTemplate(t: ViewTemplate): void {
    this.tDraft = {
      id: t.id,
      name: t.name,
      headerHtml: t.headerHtml,
      rowHtml: t.rowHtml,
      footerHtml: t.footerHtml,
    };
    this.mode = 'template';
  }

  private copyTemplate(t: ViewTemplate): void {
    this.tDraft = {
      id: null,
      name: `${t.name} copy`,
      headerHtml: t.headerHtml,
      rowHtml: t.rowHtml,
      footerHtml: t.footerHtml,
    };
    this.mode = 'template';
  }

  private async deleteTemplate(t: ViewTemplate): Promise<void> {
    const ctx = await getContext();
    // A built-in is part of the app, not user data. The list hides its Delete
    // button, so this only catches a call from elsewhere (a plugin, a test).
    if (t.builtin) {
      await ctx.api.ui.dialogs.alert(
        `"${t.name}" is a built-in template and cannot be deleted. Use Copy to make your own version.`,
        'Built-in template',
      );
      return;
    }
    const ok = await ctx.api.ui.dialogs.confirm(
      `Delete the template "${t.name}"? Views already created from it keep working.`,
      'Delete template',
    );
    if (!ok) return;
    await ctx.store.viewTemplates.remove(t.id);
    document.dispatchEvent(new CustomEvent('easydb:reload-views'));
    await this.refresh();
  }

  private async saveTemplate(): Promise<void> {
    if (!this.tDraft) return;
    const d = this.tDraft;
    if (!d.name.trim()) return;
    const ctx = await getContext();
    if (d.id) {
      // Editing a built-in template turns it into a plain user template: it keeps
      // the SAME id (so there's no duplicate) but drops the `builtin` flag, so the
      // seeder never resets it or re-creates a second copy, and later edits just
      // patch this same row.
      const wasBuiltin = this.templates.find((t) => t.id === d.id)?.builtin;
      await ctx.store.viewTemplates.patch(d.id, {
        name: d.name.trim(),
        headerHtml: d.headerHtml,
        rowHtml: d.rowHtml,
        footerHtml: d.footerHtml,
        ...(wasBuiltin ? { builtin: false } : {}),
        updatedAt: Date.now(),
      });
    } else {
      await ctx.store.viewTemplates.insert({
        id: uuid(),
        workspaceId: ctx.workspaceId,
        name: d.name.trim(),
        headerHtml: d.headerHtml,
        rowHtml: d.rowHtml,
        footerHtml: d.footerHtml,
        updatedAt: Date.now(),
      });
    }
    // A template change affects every open view using it — ask the core
    // view-window manager to re-render all open views so edits show at once.
    document.dispatchEvent(new CustomEvent('easydb:reload-views'));
    await this.refresh();
    this.mode = 'list';
  }

  // -- instance creation ------------------------------------------------------

  private useTemplate(t: ViewTemplate): void {
    const tokens = extractTokens(t.headerHtml, t.rowHtml, t.footerHtml);
    const mapping: Record<string, string> = {};
    for (const tok of tokens) mapping[tok] = this.autoMap(tok);
    this.iDraft = {
      id: null,
      templateId: t.id,
      templateName: t.name,
      name: `${t.name} — ${this.table?.name ?? 'table'}`,
      tokens,
      mapping,
      limit: 0,
      readonly: false,
    };
    this.mode = 'instance';
  }

  private firstColumn(pred: (c: ColumnSpec) => boolean): string {
    const hit = this.columns.find(pred);
    return hit ? hit.field : '';
  }

  /**
   * Best-effort token→column guess: exact field/label match (case-insensitive),
   * then the labelColumn fallback, then a handful of name-based heuristics for
   * common date / URL / description tokens.
   */
  private autoMap(token: string): string {
    const lc = token.toLowerCase();
    const hit = this.columns.find(
      (c) => c.field.toLowerCase() === lc || (c.label ?? '').toLowerCase() === lc,
    );
    if (hit) return hit.field;
    // `CHECK1`, `CHECK2`, … (the RSS template's editable `$input.CHECKn` flags)
    // map to the table's Nth boolean column, so a new view gets ready-to-tick
    // checkboxes for its first couple of boolean fields.
    const checkMatch = /^check(\d+)$/i.exec(token);
    if (checkMatch) {
      const idx = Number(checkMatch[1]) - 1;
      const bools = this.columns.filter((c) => c.type === 'boolean');
      return bools[idx]?.field ?? '';
    }
    // Todo's DONE (and similar flag words) -> the first boolean column.
    const boolWords = [
      'done',
      'complete',
      'completed',
      'checked',
      'check',
      'read',
      'active',
      'enabled',
      'starred',
      'flag',
      'ok',
    ];
    if (boolWords.includes(lc)) return this.firstColumn((c) => c.type === 'boolean');

    // Fall back to the table's designated label column (e.g. Datasette's
    // `label_column`) for a title/name/label token — a better "what identifies
    // a row" default than leaving it unmapped.
    const label = this.table?.labelColumn;
    if (label && (lc === 'title' || lc === 'name' || lc === 'label')) return label;

    const dateWords = [
      'date',
      'datetime',
      'time',
      'created',
      'updated',
      'modified',
      'timestamp',
      'day',
      'when',
    ];
    if (dateWords.includes(lc)) {
      return this.firstColumn((c) => c.type === 'date' || c.type === 'datetime');
    }

    const urlWords = ['url', 'link', 'href', 'website', 'homepage', 'uri', 'site', 'web'];
    if (urlWords.includes(lc)) {
      const linkCol = this.firstColumn((c) => c.renderer === 'link');
      if (linkCol) return linkCol;
      return this.firstColumn((c) => {
        const f = c.field.toLowerCase();
        const l = (c.label ?? '').toLowerCase();
        return urlWords.some((w) => f.includes(w) || l.includes(w));
      });
    }

    const nameContains = (words: string[]) => (c: ColumnSpec) => {
      const f = c.field.toLowerCase();
      const l = (c.label ?? '').toLowerCase();
      return words.some((w) => f.includes(w) || l.includes(w));
    };

    // Gallery's IMAGE -> an image-renderer column, else an image-named column,
    // else any URL-ish column (images are commonly stored as URLs).
    const imageWords = [
      'image',
      'img',
      'photo',
      'picture',
      'pic',
      'thumbnail',
      'thumb',
      'avatar',
      'cover',
      'poster',
      'logo',
      'icon',
    ];
    if (imageWords.includes(lc)) {
      const byRenderer = this.firstColumn((c) => c.renderer === 'image');
      if (byRenderer) return byRenderer;
      const named = this.firstColumn(nameContains(imageWords));
      if (named) return named;
      return this.firstColumn(nameContains(['url', 'src', 'href', 'link']));
    }

    // Contact Cards' EMAIL / PHONE.
    if (['email', 'mail', 'e-mail'].includes(lc)) return this.firstColumn(nameContains(['mail']));
    if (['phone', 'tel', 'telephone', 'mobile', 'cell', 'cellphone'].includes(lc)) {
      return this.firstColumn(nameContains(['phone', 'tel', 'mobile', 'cell']));
    }

    const descWords = [
      'description',
      'desc',
      'notes',
      'note',
      'body',
      'text',
      'summary',
      'about',
      'comment',
      'comments',
      'details',
      'detail',
      'remarks',
    ];
    if (descWords.includes(lc)) {
      const named = this.firstColumn((c) => {
        if (c.type !== 'string') return false;
        const f = c.field.toLowerCase();
        const l = (c.label ?? '').toLowerCase();
        return descWords.some((w) => f.includes(w) || l.includes(w));
      });
      if (named) return named;
      const stringCols = this.columns.filter((c) => c.type === 'string');
      const first = stringCols[0];
      if (!first) return '';
      let best = first;
      for (const c of stringCols) {
        if ((c.max ?? 0) > (best.max ?? 0)) best = c;
      }
      return best.field;
    }

    return '';
  }

  private async saveInstance(): Promise<void> {
    if (!this.iDraft || !this.table) return;
    const d = this.iDraft;
    if (!d.name.trim()) return;
    const ctx = await getContext();
    // Editing an existing instance: only the name and token→column mapping
    // change. The snapshotted sort / filter / visible columns are preserved.
    if (d.id) {
      await ctx.store.viewInstances.patch(d.id, {
        name: d.name.trim(),
        mapping: { ...d.mapping },
        limit: d.limit > 0 ? d.limit : undefined,
        readonly: d.readonly,
        updatedAt: Date.now(),
      });
      // Reflect the change in an already-open window.
      document.dispatchEvent(
        new CustomEvent('easydb:reload-view', { detail: { instanceId: d.id } }),
      );
      await this.refresh();
      this.mode = 'list';
      return;
    }
    // Snapshot the table's CURRENT sort / filter / visible columns.
    const visibleColumns = this.columns.filter((c) => !c.hidden).map((c) => c.field);
    const inst: ViewInstance = {
      id: uuid(),
      workspaceId: ctx.workspaceId,
      tableId: this.tableId,
      tableName: this.table.name,
      templateId: d.templateId,
      name: d.name.trim(),
      sortColumn: this.table.sortColumn,
      sortAsc: this.table.sortAsc,
      filters: { ...(this.table.filters ?? {}) },
      visibleColumns,
      mapping: { ...d.mapping },
      updatedAt: Date.now(),
      ...(d.limit > 0 ? { limit: d.limit } : {}),
      ...(d.readonly ? { readonly: true } : {}),
    };
    await ctx.store.viewInstances.insert(inst);
    await this.openInstance(inst.id);
  }

  // -- render -----------------------------------------------------------------

  private renderList() {
    return html`
      <div class="section">
        <h3>Views of “${this.table?.name ?? ''}”</h3>
        <ul class="list">
          ${this.instances.map(
            (v) =>
              html`<li>
                <span class="name">${v.name}</span>
                <button type="button" class="mini" @click=${() => this.openInstance(v.id)}>
                  Open
                </button>
                <button type="button" class="mini" @click=${() => void this.editInstance(v)}>
                  Edit
                </button>
                <button
                  type="button"
                  class="mini"
                  title="Duplicate this view, picking up columns added to the table since"
                  @click=${() => void this.copyInstance(v)}
                >
                  Copy
                </button>
                <button
                  type="button"
                  class="mini danger"
                  @click=${() => void this.deleteInstance(v.id)}
                >
                  Delete
                </button>
              </li>`,
          )}
        </ul>
      </div>
      <div class="section">
        <h3>View templates (workspace)</h3>
        <ul class="list">
          ${this.templates.map(
            (t) =>
              html`<li>
                <span class="name">${t.name}</span>
                ${t.builtin ? html`<span class="badge">built-in</span>` : nothing}
                <button type="button" class="mini" @click=${() => this.useTemplate(t)}>Use</button>
                <button type="button" class="mini" @click=${() => this.editTemplate(t)}>Edit</button>
                <button type="button" class="mini" @click=${() => this.copyTemplate(t)}>Copy</button>
                ${t.builtin
                  ? nothing
                  : html`<button
                      type="button"
                      class="mini danger"
                      title="Delete this template"
                      @click=${() => void this.deleteTemplate(t)}
                    >
                      Delete
                    </button>`}
              </li>`,
          )}
        </ul>
        <div>
          <button type="button" class="mini" @click=${() => this.newTemplate()}>
            + New template
          </button>
        </div>
        <p class="hint">
          A template's row HTML uses <code>$TOKEN</code> placeholders (e.g. <code>$TITLE</code>).
          Leave row HTML blank to show a read-only columns table with the header/footer HTML around
          it.
        </p>
      </div>
    `;
  }

  private renderTemplate() {
    const d = this.tDraft!;
    const set = (k: keyof TemplateDraft) => (e: Event) => {
      this.tDraft = { ...d, [k]: (e.target as HTMLInputElement | HTMLTextAreaElement).value };
    };
    return html`
      <label class="field">
        Name
        <input type="text" .value=${d.name} @input=${set('name')} placeholder="e.g. Cards" />
      </label>
      <label class="field">
        Header HTML
        <textarea .value=${d.headerHtml} @input=${set('headerHtml')}></textarea>
      </label>
      <label class="field">
        Row HTML <span class="hint">(blank ⇒ read-only table)</span>
        <textarea
          .value=${d.rowHtml}
          @input=${set('rowHtml')}
          placeholder="&lt;div&gt;$TITLE&lt;/div&gt;"
        ></textarea>
      </label>
      <label class="field">
        Footer HTML
        <textarea .value=${d.footerHtml} @input=${set('footerHtml')}></textarea>
      </label>
    `;
  }

  private renderInstance() {
    const d = this.iDraft!;
    return html`
      <label class="field">
        View name
        <input
          type="text"
          .value=${d.name}
          @input=${(e: Event) =>
            (this.iDraft = { ...d, name: (e.target as HTMLInputElement).value })}
        />
      </label>
      <label class="field">
        Show at most (rows, 0 = all)
        <input
          type="number"
          min="0"
          .value=${String(d.limit)}
          @input=${(e: Event) =>
            (this.iDraft = {
              ...d,
              limit: Math.max(0, Number((e.target as HTMLInputElement).value) || 0),
            })}
        />
      </label>
      <label class="field-inline">
        <input
          type="checkbox"
          .checked=${d.readonly}
          @change=${(e: Event) =>
            (this.iDraft = { ...d, readonly: (e.target as HTMLInputElement).checked })}
        />
        Readonly (show values without editors in the table view)
      </label>
      <div class="section">
        <h3>Map placeholders to columns</h3>
        ${d.tokens.length === 0
          ? html`<p class="hint">
              This template has no <code>$TOKEN</code> placeholders — it will show the read-only
              table with your current sort, filter and visible columns.
            </p>`
          : d.tokens.map(
              (tok) =>
                html`<div class="map-row">
                  <code>$${tok}</code>
                  <select
                    @change=${(e: Event) =>
                      (this.iDraft = {
                        ...d,
                        mapping: { ...d.mapping, [tok]: (e.target as HTMLSelectElement).value },
                      })}
                  >
                    <option value="" ?selected=${!d.mapping[tok]}>— none —</option>
                    ${this.columns.map(
                      (c) =>
                        html`<option value=${c.field} ?selected=${d.mapping[tok] === c.field}>
                          ${c.label || c.field}
                        </option>`,
                    )}
                  </select>
                </div>`,
            )}
      </div>
      <p class="hint">
        ${d.id
          ? html`Editing name and column mapping. The snapshotted sort, filters and visible columns
            are kept.`
          : html`The view snapshots this table's current sort, filters and visible columns.`}
      </p>
    `;
  }

  override render() {
    const title =
      this.mode === 'template'
        ? this.tDraft?.id
          ? 'Edit template'
          : 'New template'
        : this.mode === 'instance'
          ? `${this.iDraft?.id ? 'Edit' : 'New'} view — ${this.iDraft?.templateName ?? ''}`
          : 'Views';

    const actions =
      this.mode === 'template'
        ? html`<button type="button" class="ghost" @click=${() => (this.mode = 'list')}>
              Back
            </button>
            <button type="submit" class="primary">Save</button>`
        : this.mode === 'instance'
          ? html`<button type="button" class="ghost" @click=${() => (this.mode = 'list')}>
                Back
              </button>
              <button type="submit" class="primary">
                ${this.iDraft?.id ? 'Save' : 'Create view'}
              </button>`
          : html`<button type="submit" class="ghost">Close</button>`;

    return html`
      <dialog @cancel=${this.close} @keydown=${ctrlEnterSubmits}>
        <button type="button" class="close-x" title="Close" @click=${this.close}>×</button>
        <form @submit=${this.onSubmit}>
          <div class="dialog-header">
            <h2>${title}</h2>
            <div class="header-actions">${actions}</div>
          </div>
          <div class="dialog-body">
            ${this.mode === 'template'
              ? this.renderTemplate()
              : this.mode === 'instance'
                ? this.renderInstance()
                : this.renderList()}
          </div>
        </form>
      </dialog>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'views-dialog': ViewsDialog;
  }
}
