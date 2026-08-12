import { LitElement, css, html, nothing } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import type { ColumnSpec, SettingsFieldSpec, Table, ViewInstance, ViewTemplate, VisualizationSpec, VizMeasureFn, VizSpec } from '@easydb/shared';
import { getContext } from '../app-context.js';
import { ctrlEnterSubmits, dialogChromeStyles, makeDialogDraggable } from '@cawoodm/lit-dialogs';
import { watchDialogDirty } from '../chrome/dirty-guard.js';
import { extractTokens } from '../views/view-render.js';
import { revealViewWindow } from '../window-mgr/view-window-manager.js';
import { ScriptEditorDialog } from './script-editor-dialog.js';

/**
 * Open the Views manager for a table (mounted lazily into <body>). Pass
 * `editTemplateId` to jump straight into editing that template, or
 * `editInstanceId` to jump into editing that view instance (rename / re-map) —
 * both used by the icon buttons in a view window's footer.
 */
export function openViewsDialog(tableId: string, opts?: { editTemplateId?: string; editInstanceId?: string }): void {
  const dlg = ViewsDialog.instance ?? mount();
  void dlg.open(tableId, opts);
}

function mount(): ViewsDialog {
  const el = document.createElement('views-dialog') as ViewsDialog;
  document.body.appendChild(el);
  return el;
}

function uuid(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

interface TemplateDraft {
  id: string | null; // null ⇒ new
  name: string;
  headerHtml: string;
  rowHtml: string;
  footerHtml: string;
  /** 'viz' ⇒ the template DRAWS; the three HTML fields stay unused. */
  kind: 'html' | 'viz';
  /** The drawing spec, when `kind === 'viz'`. */
  viz: VizSpec | null;
}

interface InstanceDraft {
  id: string | null; // null ⇒ new instance
  templateId: string;
  templateName: string;
  name: string;
  tokens: string[];
  mapping: Record<string, string>;
  /** Token → `render(row)` script formatting what the token shows. */
  tokenScripts: Record<string, string>;
  /** Token → true when it must show plain text, not the column's renderer. */
  tokenRaw: Record<string, boolean>;
  limit: number; // 0 = all
  readonly: boolean; // grid (template-off) view shows values with no editors
  /** Where it is shown. 'window' ⇒ its own panel; otherwise docked to the table. */
  dock: 'window' | 'above' | 'below';
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
        grid-template-columns: 8rem 1fr auto auto;
        align-items: center;
        gap: 0.5rem;
      }
      .map-row code {
        font-family: ui-monospace, SFMono-Regular, monospace;
        color: #2563eb;
      }
      /* A visualization's slot is a named data CHANNEL, not a $TOKEN, so it
         reads as prose rather than as code. */
      .map-row .channel {
        font-weight: 600;
      }
      /* A token whose script is set says so on the button itself — the script
         lives in a modal, so nothing else in the row would show it. */
      button.mini.scripted {
        border-color: #2563eb;
        color: #2563eb;
        background: #eff6ff;
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
  /**
   * True when the dialog was opened directly onto an editor instead of onto the
   * list — i.e. the user came from a chart's Edit or Chart button to change one
   * thing. Decides where Save goes; see `doneEditing`.
   */
  private deepLinked = false;
  /**
   * Snapshotted so the template editor can list the registered drawing kinds.
   * Re-read on every `refresh()` rather than captured once, for the same reason
   * `data-table` re-snapshots its cell renderers on `app:ready`: a plugin
   * hot-installed from the Plugin Manager has to show up here without a reload.
   */
  private registries: { visualizations: Map<string, VisualizationSpec> } | null = null;

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
    if (this.dialogEl) watchDialogDirty('views', this.dialogEl);
  }

  async open(tableId: string, opts?: { editTemplateId?: string; editInstanceId?: string }): Promise<void> {
    this.tableId = tableId;
    this.mode = 'list';
    this.tDraft = null;
    this.iDraft = null;
    // Opened straight onto one editor (a visualization's Edit / Chart button)
    // rather than onto the list. Save then FINISHES — see `doneEditing`.
    this.deepLinked = Boolean(opts?.editTemplateId || opts?.editInstanceId);
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
    this.registries = ctx.registries;
    this.table = await ctx.store.tables.findOne(this.tableId);
    this.columns = this.table?.columns ?? [];
    this.instances = (await ctx.store.viewInstances.find({ workspaceId: wsId })).filter((v) => v.tableId === this.tableId);
    this.templates = (await ctx.store.viewTemplates.find({ workspaceId: wsId })).sort((a, b) => a.name.localeCompare(b.name));
  }

  private close = (): void => {
    this.dialogEl?.close();
  };

  /**
   * Where Save goes after a successful edit.
   *
   * Back to the list when the user navigated there themselves — they were
   * browsing and may well want to edit something else. But when the dialog was
   * opened straight onto this editor from a chart's own footer, the list is
   * somewhere they never asked to be: they came to change one thing, so Save
   * finishes and the chart they were looking at is visible again.
   */
  private doneEditing(): void {
    if (this.deepLinked) this.close();
    else this.mode = 'list';
  }

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
    // The dialog owns intent, not window management — `revealViewWindow` is the
    // core manager's "show me this view": it flips the persisted `open` flag
    // when the window is closed, and fronts / restores / positions it either
    // way. Flipping the flag here directly was the bug: for a view that was
    // ALREADY open the flag did not change, so the reconcile had nothing to do
    // and Open looked broken.
    this.close();
    await revealViewWindow(id);
  }

  /** Edit an existing instance: rename it and/or re-map its template tokens. */
  private async editInstance(inst: ViewInstance): Promise<void> {
    const ctx = await getContext();
    const tpl = await ctx.store.viewTemplates.findOne(inst.templateId);
    // Recover the template's live slots. For a VIZ template those are the
    // visualization's channel keys, not `$TOKEN`s scraped from HTML — the same
    // split `useTemplate` makes. Falling back to what the instance already
    // mapped covers a missing template and a kind whose plugin is switched off,
    // either of which would otherwise show an edit form with nothing to map.
    const vizSpec = tpl?.kind === 'viz' ? this.vizSpecOf(tpl.viz?.kind) : null;
    const tokens = vizSpec
      ? vizSpec.channels.map((c) => c.key)
      : tpl?.kind === 'viz'
        ? Object.keys(inst.mapping)
        : tpl
          ? extractTokens(tpl.headerHtml, tpl.rowHtml, tpl.footerHtml)
          : Object.keys(inst.mapping);
    this.iDraft = {
      id: inst.id,
      templateId: inst.templateId,
      templateName: tpl?.name ?? 'template',
      name: inst.name,
      tokens,
      mapping: { ...inst.mapping },
      tokenScripts: { ...(inst.tokenScripts ?? {}) },
      tokenRaw: { ...(inst.tokenRaw ?? {}) },
      limit: inst.limit ?? 0,
      dock: inst.dock ? inst.dock.edge : 'window',
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

  private newTemplate(kind: 'html' | 'viz' = 'html'): void {
    const first = kind === 'viz' ? this.visualizations()[0] : undefined;
    this.tDraft = {
      id: null,
      name: '',
      headerHtml: '',
      rowHtml: '',
      footerHtml: '',
      kind,
      viz: first ? { kind: first.id, aggregate: first.defaultAggregate, options: {} } : null,
    };
    this.mode = 'template';
  }

  /** Every registered drawing kind, in registration order. */
  private visualizations(): VisualizationSpec[] {
    return [...(this.registries?.visualizations.values() ?? [])];
  }

  private vizSpecOf(id: string | undefined): VisualizationSpec | null {
    return id ? (this.registries?.visualizations.get(id) ?? null) : null;
  }

  private editTemplate(t: ViewTemplate): void {
    this.tDraft = {
      id: t.id,
      name: t.name,
      headerHtml: t.headerHtml,
      rowHtml: t.rowHtml,
      footerHtml: t.footerHtml,
      kind: t.kind === 'viz' ? 'viz' : 'html',
      viz: t.viz ? { ...t.viz } : null,
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
      kind: t.kind === 'viz' ? 'viz' : 'html',
      viz: t.viz ? { ...t.viz } : null,
    };
    this.mode = 'template';
  }

  /**
   * Delete a template after a confirm. EVERY template can go, built-ins
   * included: a workspace that does not want the shipped Gallery or RSS should be
   * able to be rid of it. The seeder respects that — it only ever seeds a slug it
   * has not seeded in this workspace before — so a deleted built-in does not come
   * back on the next load, which the confirm says out loud.
   */
  private async deleteTemplate(t: ViewTemplate): Promise<void> {
    const ctx = await getContext();
    const ok = await ctx.api.ui.dialogs.confirm(
      t.builtin
        ? `Delete the built-in template "${t.name}"? It will not be seeded again in this ` + `workspace. Views already created from it keep working.`
        : `Delete the template "${t.name}"? Views already created from it keep working.`,
      t.builtin ? 'Delete built-in template' : 'Delete template',
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
    // Template names are how a view reports which template it uses, and Copy
    // proposes "<name> copy" — two templates called the same thing are then
    // impossible to tell apart in the list. Compared case-insensitively, and
    // against the OTHER templates only, so re-saving a template is fine.
    const clash = this.templates.find((t) => t.id !== d.id && t.name.trim().toLowerCase() === d.name.trim().toLowerCase());
    if (clash) {
      await ctx.api.ui.dialogs.alert(`A template called “${clash.name}” already exists. Pick another name.`, 'Duplicate template name');
      return;
    }
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
        kind: d.kind,
        // Written as `undefined` for an html template rather than left alone, so
        // switching a template back from viz does not leave a stale spec behind.
        viz: d.kind === 'viz' && d.viz ? d.viz : undefined,
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
        kind: d.kind,
        ...(d.kind === 'viz' && d.viz ? { viz: d.viz } : {}),
        updatedAt: Date.now(),
      });
    }
    // A template change affects every open view using it — ask the core
    // view-window manager to re-render all open views so edits show at once.
    document.dispatchEvent(new CustomEvent('easydb:reload-views'));
    await this.refresh();
    this.doneEditing();
  }

  // -- instance creation ------------------------------------------------------

  private useTemplate(t: ViewTemplate): void {
    // A viz template's "tokens" are its visualization's CHANNEL keys. Same
    // `mapping` record, same UI, different source for the key list — which is the
    // whole economy of making a visualization a kind of view.
    const spec = t.kind === 'viz' ? this.vizSpecOf(t.viz?.kind) : null;
    const tokens = spec ? spec.channels.map((c) => c.key) : extractTokens(t.headerHtml, t.rowHtml, t.footerHtml);
    const mapping: Record<string, string> = {};
    for (const tok of tokens) {
      const ch = spec?.channels.find((c) => c.key === tok);
      mapping[tok] = ch ? this.autoMapChannel(ch) : this.autoMap(tok);
    }
    this.iDraft = {
      id: null,
      templateId: t.id,
      templateName: t.name,
      name: `${t.name} — ${this.table?.name ?? 'table'}`,
      tokens,
      mapping,
      tokenScripts: {},
      tokenRaw: {},
      limit: 0,
      readonly: false,
      dock: 'window',
    };
    this.mode = 'instance';
  }

  /**
   * Guess a column for a visualization channel.
   *
   * Tries the channel's own name first (so a column literally called "Category"
   * wins), then the declared `kind`, which is the part that makes a chart draw
   * something sensible the moment it is created: a `value` channel wants a
   * number, a `time` channel a date, `lat`/`lon` the obvious names. Narrowed by
   * `accepts` throughout — offering a text column as a latitude only produces an
   * empty map.
   */
  private autoMapChannel(ch: { key: string; kind: string; accepts?: readonly ColumnSpec['type'][] | undefined }): string {
    const ok = (c: ColumnSpec): boolean => !ch.accepts || ch.accepts.length === 0 || ch.accepts.includes(c.type);
    const byName = this.autoMap(ch.key);
    if (byName && this.columns.some((c) => c.field === byName && ok(c))) return byName;
    const nameHit = (words: string[]): string => {
      const hit = this.columns.find((c) => ok(c) && words.some((w) => `${c.field} ${c.label ?? ''}`.toLowerCase().includes(w)));
      return hit?.field ?? '';
    };
    switch (ch.kind) {
      case 'lat':
        return nameHit(['latitude', 'lat']) || this.firstColumn((c) => ok(c));
      case 'lon':
        return nameHit(['longitude', 'lon', 'lng']) || this.firstColumn((c) => ok(c));
      case 'time':
        return this.firstColumn((c) => ok(c) && (c.type === 'date' || c.type === 'datetime')) || this.firstColumn(ok);
      case 'value':
      case 'weight':
        return this.firstColumn((c) => ok(c) && c.type === 'number') || '';
      case 'text':
        // The longest-looking text column beats the first one: a cloud of a
        // 3-character status code is not a word cloud.
        return nameHit(['description', 'text', 'body', 'comment', 'notes', 'title', 'name']) || this.firstColumn((c) => ok(c) && c.type === 'string');
      case 'category':
        return this.firstColumn((c) => ok(c) && (c.type === 'string' || c.type === 'array')) || this.firstColumn(ok);
      default:
        return '';
    }
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
    const hit = this.columns.find((c) => c.field.toLowerCase() === lc || (c.label ?? '').toLowerCase() === lc);
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
    const boolWords = ['done', 'complete', 'completed', 'checked', 'check', 'read', 'active', 'enabled', 'starred', 'flag', 'ok'];
    if (boolWords.includes(lc)) return this.firstColumn((c) => c.type === 'boolean');

    // Fall back to the table's designated label column (e.g. Datasette's
    // `label_column`) for a title/name/label token — a better "what identifies
    // a row" default than leaving it unmapped.
    const label = this.table?.labelColumn;
    if (label && (lc === 'title' || lc === 'name' || lc === 'label')) return label;

    const dateWords = ['date', 'datetime', 'time', 'created', 'updated', 'modified', 'timestamp', 'day', 'when'];
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
    const imageWords = ['image', 'img', 'photo', 'picture', 'pic', 'thumbnail', 'thumb', 'avatar', 'cover', 'poster', 'logo', 'icon'];
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

    const descWords = ['description', 'desc', 'notes', 'note', 'body', 'text', 'summary', 'about', 'comment', 'comments', 'details', 'detail', 'remarks'];
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

  /**
   * The draft's token scripts, dropped when nothing is scripted — the common
   * case, and `undefined` in a patch is how the field goes away again after the
   * last script is cleared.
   */
  private draftScripts(d: InstanceDraft): Record<string, string> | undefined {
    const kept = Object.entries(d.tokenScripts).filter(([, src]) => src.trim());
    return kept.length ? Object.fromEntries(kept) : undefined;
  }

  /**
   * The tokens held back to plain text, dropped when every token renders — which
   * is the default, so the field stays absent on almost every instance.
   */
  private draftRaw(d: InstanceDraft): Record<string, boolean> | undefined {
    const kept = Object.entries(d.tokenRaw).filter(([, on]) => on === true);
    return kept.length ? Object.fromEntries(kept) : undefined;
  }

  /** Flip one token between the column's renderer and plain text. */
  private toggleTokenRaw(tok: string): void {
    const d = this.iDraft;
    if (!d) return;
    const tokenRaw = { ...d.tokenRaw };
    if (tokenRaw[tok]) delete tokenRaw[tok];
    else tokenRaw[tok] = true;
    this.iDraft = { ...d, tokenRaw };
  }

  /**
   * Open the script editor for one token. The script formats what the token
   * SHOWS, so the mapped column is only the starting point offered in the
   * boilerplate — a token may script without mapping anything.
   */
  private async editTokenScript(tok: string): Promise<void> {
    const dlg = ScriptEditorDialog.instance;
    const d = this.iDraft;
    if (!dlg || !d) return;
    const next = await dlg.open(d.tokenScripts[tok] ?? '', `$${tok}`, 'token', { field: d.mapping[tok] ?? '' });
    if (next === null) return;
    const tokenScripts = { ...d.tokenScripts };
    if (next.trim()) tokenScripts[tok] = next;
    else delete tokenScripts[tok];
    this.iDraft = { ...d, tokenScripts };
  }

  /** Is this draft an instance of a viz template? */
  private isVizDraft(d: InstanceDraft): boolean {
    return this.templates.find((t) => t.id === d.templateId)?.kind === 'viz';
  }

  /** The human label for a channel key, falling back to the key itself. */
  private channelLabel(d: InstanceDraft, key: string): string {
    const tpl = this.templates.find((t) => t.id === d.templateId);
    const spec = this.vizSpecOf(tpl?.viz?.kind);
    return spec?.channels.find((c) => c.key === key)?.label ?? key;
  }

  private async saveInstance(): Promise<void> {
    if (!this.iDraft || !this.table) return;
    const d = this.iDraft;
    if (!d.name.trim()) return;
    const ctx = await getContext();
    const tokenScripts = this.draftScripts(d);
    const tokenRaw = this.draftRaw(d);
    // Editing an existing instance: only the name and token→column mapping
    // change. The snapshotted sort / filter / visible columns are preserved.
    if (d.id) {
      await ctx.store.viewInstances.patch(d.id, {
        name: d.name.trim(),
        mapping: { ...d.mapping },
        tokenScripts,
        tokenRaw,
        limit: d.limit > 0 ? d.limit : undefined,
        readonly: d.readonly,
        dock: this.dockFor(d),
        updatedAt: Date.now(),
      });
      // Reflect the change in an already-open window.
      document.dispatchEvent(new CustomEvent('easydb:reload-view', { detail: { instanceId: d.id } }));
      await this.refresh();
      this.doneEditing();
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
      ...(tokenScripts ? { tokenScripts } : {}),
      ...(tokenRaw ? { tokenRaw } : {}),
      ...(this.dockFor(d) ? { dock: this.dockFor(d) } : {}),
    };
    await ctx.store.viewInstances.insert(inst);
    // A docked pane has no window to reveal — flipping `open` is what mounts it,
    // and the reconciler in `view-window-manager.ts` does the rest.
    if (d.dock === 'window') await this.openInstance(inst.id);
    else {
      await ctx.store.viewInstances.patch(inst.id, { open: true, updatedAt: Date.now() });
      await this.refresh();
      this.close();
    }
  }

  /**
   * The `dock` descriptor for a draft, or `undefined` for a windowed view.
   *
   * `order` is the count of panes already on that edge, so a second chart lands
   * beneath the first rather than fighting it for position 0.
   */
  private dockFor(d: InstanceDraft): ViewInstance['dock'] {
    if (d.dock === 'window') return undefined;
    const onEdge = this.instances.filter((i) => i.id !== d.id && i.dock?.edge === d.dock && i.dock?.host.kind === 'table' && i.dock.host.tableId === this.tableId).length;
    const existing = d.id ? this.instances.find((i) => i.id === d.id)?.dock : undefined;
    return {
      host: { kind: 'table', tableId: this.tableId },
      edge: d.dock,
      // Keep a height the user already dragged to; a fresh pane gets a default
      // that shows a chart without dominating the grid.
      size: existing?.size ?? 160,
      order: existing?.order ?? onEdge,
    };
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
                <button type="button" class="mini" @click=${() => this.openInstance(v.id)}>Open</button>
                <button type="button" class="mini" @click=${() => void this.editInstance(v)}>Edit</button>
                <button type="button" class="mini" title="Duplicate this view, picking up columns added to the table since" @click=${() => void this.copyInstance(v)}>Copy</button>
                <button type="button" class="mini danger" @click=${() => void this.deleteInstance(v.id)}>Delete</button>
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
                <button
                  type="button"
                  class="mini danger"
                  title=${t.builtin ? 'Delete this built-in template (it will not be seeded again)' : 'Delete this template'}
                  @click=${() => void this.deleteTemplate(t)}
                >
                  Delete
                </button>
              </li>`,
          )}
        </ul>
        <div>
          <button type="button" class="mini" @click=${() => this.newTemplate('html')}>+ New template</button>
          ${this.visualizations().length > 0 ? html`<button type="button" class="mini" @click=${() => this.newTemplate('viz')}>+ New chart</button>` : nothing}
        </div>
        <p class="hint">
          A template's row HTML uses <code>$TOKEN</code> placeholders (e.g. <code>$TITLE</code>). Leave row HTML blank to show a read-only columns table with the header/footer HTML around it.
        </p>
        <p class="hint">A chart template draws instead — bar, line, pie, a map or a word cloud — in its own window or docked above or below the table.</p>
      </div>
    `;
  }

  private renderTemplate() {
    const d = this.tDraft!;
    void 0;
    const set = (k: keyof TemplateDraft) => (e: Event) => {
      this.tDraft = { ...d, [k]: (e.target as HTMLInputElement | HTMLTextAreaElement).value };
    };
    return html`
      <label class="field">
        Name
        <input type="text" .value=${d.name} @input=${set('name')} placeholder="e.g. Cards" />
      </label>
      ${d.kind === 'viz' ? this.renderVizTemplate(d) : this.renderHtmlTemplate(d, set)}
    `;
  }

  private renderHtmlTemplate(d: TemplateDraft, set: (k: 'headerHtml' | 'rowHtml' | 'footerHtml') => (e: Event) => void) {
    return html`
      <label class="field">
        Header HTML
        <textarea .value=${d.headerHtml} @input=${set('headerHtml')}></textarea>
      </label>
      <label class="field">
        Row HTML <span class="hint">(blank ⇒ read-only table)</span>
        <textarea .value=${d.rowHtml} @input=${set('rowHtml')} placeholder="&lt;div&gt;$TITLE&lt;/div&gt;"></textarea>
      </label>
      <label class="field">
        Footer HTML
        <textarea .value=${d.footerHtml} @input=${set('footerHtml')}></textarea>
      </label>
    `;
  }

  /** Patch the draft's `viz` spec, keeping everything else. */
  private setViz(patch: Partial<VizSpec>): void {
    const d = this.tDraft;
    if (!d?.viz) return;
    this.tDraft = { ...d, viz: { ...d.viz, ...patch } };
  }

  private setAggregate(patch: Partial<NonNullable<VizSpec['aggregate']>>): void {
    const d = this.tDraft;
    if (!d?.viz) return;
    const spec = this.vizSpecOf(d.viz.kind);
    const base = d.viz.aggregate ?? spec?.defaultAggregate ?? { groupBy: ['CATEGORY'], measures: [{ channel: 'VALUE', fn: 'count' as VizMeasureFn }] };
    this.tDraft = { ...d, viz: { ...d.viz, aggregate: { ...base, ...patch } } };
  }

  private renderVizTemplate(d: TemplateDraft) {
    const kinds = this.visualizations();
    if (kinds.length === 0) {
      return html`<p class="hint">No visualizations are registered. Enable the Charts, Map or Word cloud plugins in the Plugin Manager.</p>`;
    }
    const spec = this.vizSpecOf(d.viz?.kind) ?? kinds[0];
    if (!spec) return nothing;
    const agg = d.viz?.aggregate ?? spec.defaultAggregate ?? null;
    const measure = agg?.measures[0];
    const opts = (d.viz?.options ?? {}) as Record<string, unknown>;

    return html`
      <label class="field">
        Visualization
        <select
          @change=${(e: Event) => {
            const next = this.vizSpecOf((e.target as HTMLSelectElement).value);
            // Switching kind resets the aggregate to the new kind's default — a
            // pie's topN or a line's category sort are part of what the kind IS,
            // and carrying the old one over produced nonsense (a line sorted by
            // size). Options are reset for the same reason: they are per-kind.
            if (next) this.setViz({ kind: next.id, aggregate: next.defaultAggregate, options: {} });
          }}
        >
          ${kinds.map((k) => html`<option value=${k.id} ?selected=${k.id === spec.id}>${k.label}</option>`)}
        </select>
      </label>
      ${spec.data === 'aggregate' && agg
        ? html`
            <div class="section">
              <h3>What it measures</h3>
              <label class="field">
                Aggregate
                <select @change=${(e: Event) => this.setAggregate({ measures: [{ channel: 'VALUE', fn: (e.target as HTMLSelectElement).value as VizMeasureFn }] })}>
                  ${(
                    [
                      ['count', 'Count of rows'],
                      ['sum', 'Sum of the value column'],
                      ['avg', 'Average of the value column'],
                      ['min', 'Minimum of the value column'],
                      ['max', 'Maximum of the value column'],
                      ['countDistinct', 'Distinct values of the value column'],
                    ] as Array<[VizMeasureFn, string]>
                  ).map(([fn, label]) => html`<option value=${fn} ?selected=${measure?.fn === fn}>${label}</option>`)}
                </select>
              </label>
              <label class="field">
                Order
                <select @change=${(e: Event) => this.setAggregate({ sort: (e.target as HTMLSelectElement).value as 'category' | 'value' | 'valueDesc' })}>
                  <option value="category" ?selected=${agg.sort === 'category'}>By category</option>
                  <option value="valueDesc" ?selected=${agg.sort === 'valueDesc'}>Largest first</option>
                  <option value="value" ?selected=${agg.sort === 'value'}>Smallest first</option>
                </select>
              </label>
              <label class="field">
                Show at most (groups, 0 = all)
                <span class="hint">The rest are folded into one “Other”, never dropped.</span>
                <input
                  type="number"
                  min="0"
                  .value=${String(agg.topN ?? 0)}
                  @input=${(e: Event) => {
                    const n = Math.max(0, Number((e.target as HTMLInputElement).value) || 0);
                    this.setAggregate(n > 0 ? { topN: n } : { topN: undefined });
                  }}
                />
              </label>
            </div>
          `
        : nothing}
      ${spec.options && spec.options.length > 0
        ? html`
            <div class="section">
              <h3>Options</h3>
              ${spec.options.map((f) => this.renderVizOption(f, opts))}
            </div>
          `
        : nothing}
      <p class="hint">Columns are mapped when you create a view from this template, so one chart works on any table with matching columns.</p>
    `;
  }

  /**
   * One visualization option, rendered from its `SettingsFieldSpec`.
   *
   * The same field shapes the Settings dialog renders, deliberately: a new chart
   * option is a line of data in a plugin, not UI code here.
   */
  private renderVizOption(f: SettingsFieldSpec, opts: Record<string, unknown>) {
    const cur = opts[f.key] ?? f.default;
    const write = (v: unknown): void => this.setViz({ options: { ...opts, [f.key]: v } });
    if (f.type === 'boolean') {
      return html`<label class="field-inline">
        <input type="checkbox" .checked=${cur === true} @change=${(e: Event) => write((e.target as HTMLInputElement).checked)} />
        ${f.label}
      </label>`;
    }
    if (f.type === 'number') {
      return html`<label class="field">
        ${f.label} ${f.description ? html`<span class="hint">${f.description}</span>` : nothing}
        <input type="number" .value=${cur == null ? '' : String(cur)} @input=${(e: Event) => write(Number((e.target as HTMLInputElement).value) || 0)} />
      </label>`;
    }
    if (f.type === 'option' && f.options) {
      return html`<label class="field">
        ${f.label}
        <select @change=${(e: Event) => write((e.target as HTMLSelectElement).value)}>
          ${f.options.map((o) => html`<option value=${o} ?selected=${cur === o}>${o}</option>`)}
        </select>
      </label>`;
    }
    return html`<label class="field">
      ${f.label} ${f.description ? html`<span class="hint">${f.description}</span>` : nothing}
      <input type="text" .value=${cur == null ? '' : String(cur)} @input=${(e: Event) => write((e.target as HTMLInputElement).value)} />
    </label>`;
  }

  private renderInstance() {
    const d = this.iDraft!;
    return html`
      <label class="field">
        View name
        <input type="text" .value=${d.name} @input=${(e: Event) => (this.iDraft = { ...d, name: (e.target as HTMLInputElement).value })} />
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
      ${this.isVizDraft(d)
        ? html`<label class="field">
            Where to show it
            <select @change=${(e: Event) => (this.iDraft = { ...d, dock: (e.target as HTMLSelectElement).value as InstanceDraft['dock'] })}>
              <option value="window" ?selected=${d.dock === 'window'}>In its own window</option>
              <option value="above" ?selected=${d.dock === 'above'}>Docked above the table</option>
              <option value="below" ?selected=${d.dock === 'below'}>Docked below the table</option>
            </select>
            <span class="hint">A docked chart follows the table's filters and search as you change them.</span>
          </label>`
        : html`<label class="field-inline">
            <input type="checkbox" .checked=${d.readonly} @change=${(e: Event) => (this.iDraft = { ...d, readonly: (e.target as HTMLInputElement).checked })} />
            Readonly (show values without editors in the table view)
          </label>`}
      <div class="section">
        <h3>${this.isVizDraft(d) ? 'Map data to columns' : 'Map placeholders to columns'}</h3>
        ${d.tokens.length === 0
          ? this.isVizDraft(d)
            ? html`<p class="hint">This visualization needs no columns mapped.</p>`
            : html`<p class="hint">This template has no <code>$TOKEN</code> placeholders — it will show the read-only table with your current sort, filter and visible columns.</p>`
          : d.tokens.map(
              (tok) =>
                html`<div class="map-row">
                  ${this.isVizDraft(d) ? html`<span class="channel">${this.channelLabel(d, tok)}</span>` : html`<code>$${tok}</code>`}
                  <select
                    @change=${(e: Event) =>
                      (this.iDraft = {
                        ...d,
                        mapping: { ...d.mapping, [tok]: (e.target as HTMLSelectElement).value },
                      })}
                  >
                    <option value="" ?selected=${!d.mapping[tok]}>— none —</option>
                    ${this.columns.map((c) => html`<option value=${c.field} ?selected=${d.mapping[tok] === c.field}>${c.label || c.field}</option>`)}
                  </select>
                  ${this.isVizDraft(d)
                    ? nothing
                    : html`<button
                          type="button"
                          class=${d.tokenRaw[tok] ? 'mini' : 'mini scripted'}
                          title=${d.tokenRaw[tok]
                            ? `$${tok} shows the plain value — click to render it with the column's renderer`
                            : `$${tok} is shown by the column's renderer — click for the plain value`}
                          @click=${() => this.toggleTokenRaw(tok)}
                        >
                          ${d.tokenRaw[tok] ? '🔤' : '🎨'}
                        </button>
                        <button
                          type="button"
                          class=${d.tokenScripts[tok]?.trim() ? 'mini scripted' : 'mini'}
                          title=${d.tokenScripts[tok]?.trim() ? `Edit the script formatting $${tok}` : `Format $${tok} with a script (e.g. a local date, markdown as HTML)`}
                          @click=${() => void this.editTokenScript(tok)}
                        >
                          ƒ(x)
                        </button>`}
                </div>`,
            )}
      </div>
      ${this.isVizDraft(d)
        ? nothing
        : html`<p class="hint">
            🎨 shows the token through the column's own cell renderer, so the view looks like the table; 🔤 shows the plain value instead (the same as writing <code>$raw.TOKEN</code>). A token inside
            a tag, as in <code>&lt;img src="$IMAGE"&gt;</code>, always stays plain.
          </p>`}
      ${this.isVizDraft(d)
        ? nothing
        : html`<p class="hint">
            <code>ƒ(x)</code> gives a token a <code>render(row)</code> script, so the view can show a formatted value — a local date, markdown as HTML — without changing the stored cell. It applies to
            <code>$TOKEN</code> only, not to <code>$input.</code> or <code>$filter.</code>.
          </p>`}
      <p class="hint">
        ${this.isVizDraft(d)
          ? d.id
            ? html`Editing this visualization. Use <strong>Chart</strong> in the window footer to change the kind, the aggregate or the options — those are shared by every view of this chart.`
            : html`The visualization reads this table's rows; a docked one follows the grid's filters live.`
          : d.id
            ? html`Editing name and column mapping. The snapshotted sort, filters and visible columns are kept.`
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
        ? html`<button type="button" class="ghost" @click=${() => (this.mode = 'list')}>Back</button> <button type="submit" class="primary">Save</button>`
        : this.mode === 'instance'
          ? html`<button type="button" class="ghost" @click=${() => (this.mode = 'list')}>Back</button> <button type="submit" class="primary">${this.iDraft?.id ? 'Save' : 'Create view'}</button>`
          : html`<button type="submit" class="ghost">Close</button>`;

    return html`
      <dialog @cancel=${this.close} @keydown=${ctrlEnterSubmits}>
        <button type="button" class="close-x" title="Close" @click=${this.close}>×</button>
        <form @submit=${this.onSubmit}>
          <div class="dialog-header">
            <h2>${title}</h2>
            <div class="header-actions">${actions}</div>
          </div>
          <div class="dialog-body">${this.mode === 'template' ? this.renderTemplate() : this.mode === 'instance' ? this.renderInstance() : this.renderList()}</div>
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
