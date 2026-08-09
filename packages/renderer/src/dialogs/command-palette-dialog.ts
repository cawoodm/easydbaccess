import { LitElement, css, html } from 'lit';
import { customElement, query, state } from 'lit/decorators.js';
import { unsafeSVG } from 'lit/directives/unsafe-svg.js';
import type { CommandSpec, HostApi } from '@easydb/shared';
import { getContext } from '../app-context.js';
import { materialIconStyles } from '../chrome/material-icon-css.js';
import { focusTableWindow } from '../window-mgr/table-window-manager.js';
import { revealViewWindow } from '../window-mgr/view-window-manager.js';
import { RECENT_GROUP, RECENT_SETTING, orderByRecent, pruneRecent, pushRecent, readRecent } from './palette-recent.js';

/** One selectable entry in the palette (flattened from commands/buttons/tables). */
interface PaletteItem {
  id: string;
  title: string;
  group: string;
  icon?: string;
  /** Lower-cased haystack for search (title + keywords + group). */
  haystack: string;
  run: () => void | Promise<void>;
}

/** Group display order; unknown groups sort last (alphabetically). */
const GROUP_RANK: Record<string, number> = {
  [RECENT_GROUP]: -1,
  Windows: 0,
  Actions: 1,
  App: 2,
  Tables: 3,
  Views: 4,
};
function groupRank(g: string): number {
  return GROUP_RANK[g] ?? 3;
}

function renderIcon(icon: string | undefined) {
  if (!icon) return html`<span class="mi sm">chevron_right</span>`;
  if (icon.trimStart().startsWith('<svg')) return html`<span class="cmd-svg">${unsafeSVG(icon)}</span>`;
  return html`<span class="mi sm">${icon}</span>`;
}

/**
 * Ctrl+K / Cmd+K command palette. Its list is composed at open() from three
 * sources: commands registered via `api.ui.registerCommand` (core window ops +
 * any plugin commands), the existing header/footer buttons (so New Table /
 * Import / Export / Gist / Sync / Settings are all reachable), and a "Go to
 * <table>" entry per table in the workspace. Type to filter, ↑/↓ to move,
 * Enter to run, Esc or a click outside to close.
 *
 * The last few commands that ran are moved to a "Recent" section at the top
 * (see `palette-recent.ts`), so Ctrl+K Enter repeats the last one.
 */
@customElement('command-palette-dialog')
export class CommandPaletteDialog extends LitElement {
  static override styles = [
    materialIconStyles,
    css`
      dialog {
        width: 560px;
        max-width: 94vw;
        padding: 0;
        border: 1px solid #d1d5db;
        border-radius: 0.6rem;
        box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
        margin-top: 12vh;
      }
      dialog::backdrop {
        background: rgba(0, 0, 0, 0.25);
      }
      .search-row {
        display: flex;
        align-items: center;
        gap: 0.5rem;
        padding: 0.7rem 0.9rem;
        border-bottom: 1px solid #eee;
      }
      .search-row .mi {
        color: #9ca3af;
      }
      input {
        flex: 1;
        font: inherit;
        font-size: 1rem;
        border: 0;
        outline: none;
        background: transparent;
      }
      .list {
        max-height: 52vh;
        overflow: auto;
        padding: 0.35rem;
      }
      .group-head {
        font-size: 0.7rem;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        color: #9ca3af;
        padding: 0.5rem 0.6rem 0.25rem;
      }
      .item {
        display: flex;
        align-items: center;
        gap: 0.6rem;
        padding: 0.45rem 0.6rem;
        border-radius: 0.35rem;
        cursor: pointer;
        color: #111827;
      }
      .item .cmd-svg {
        display: inline-flex;
        width: 1.05rem;
        height: 1.05rem;
        color: #6b7280;
      }
      .item .cmd-svg svg {
        width: 100%;
        height: 100%;
      }
      .item .mi {
        color: #6b7280;
      }
      .item .title {
        flex: 1;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .item.sel {
        background: #eff6ff;
        color: #1d4ed8;
      }
      .item.sel .mi,
      .item.sel .cmd-svg {
        color: #1d4ed8;
      }
      .empty {
        padding: 1rem 0.9rem;
        color: #6b7280;
        font-size: 0.9rem;
      }
    `,
  ];

  @state() private search = '';
  @state() private items: PaletteItem[] = [];
  @state() private selected = 0;
  @query('dialog') private dialogEl?: HTMLDialogElement;
  @query('input') private inputEl?: HTMLInputElement;
  private api: HostApi | null = null;
  /** Providers asked for a command only when the query matched nothing. */
  private commandFallbacks: Array<(query: string) => CommandSpec | null> = [];
  /** Ids of the last few commands that ran, most recent first. */
  private recentIds: string[] = [];

  async open(): Promise<void> {
    const ctx = await getContext();
    this.api = ctx.api;
    this.commandFallbacks = ctx.registries.commandFallbacks;
    this.recentIds = readRecent((await ctx.api.store.settings.findOne(RECENT_SETTING))?.value);
    this.items = await this.buildItems();
    // Drop remembered ids that no longer name anything — a deleted table's
    // "Go to" is one of them — so five dead entries cannot leave Recent looking
    // full and showing nothing.
    await this.forgetVanished();
    this.search = '';
    this.selected = 0;
    await this.updateComplete;
    if (this.dialogEl && !this.dialogEl.open) this.dialogEl.showModal();
    this.inputEl?.focus();
  }

  private async buildItems(): Promise<PaletteItem[]> {
    const ctx = await getContext();
    const api = ctx.api;
    const items: PaletteItem[] = [];

    for (const c of ctx.registries.commands as CommandSpec[]) {
      items.push({
        id: c.id,
        title: c.title,
        group: c.group ?? 'Commands',
        ...(c.icon ? { icon: c.icon } : {}),
        haystack: [c.title, c.group, ...(c.keywords ?? [])].join(' ').toLowerCase(),
        run: () => c.run(api),
      });
    }

    for (const b of [...ctx.registries.headerButtons, ...ctx.registries.footerButtons]) {
      items.push({
        id: `button:${b.id}`,
        title: b.label,
        group: 'Actions',
        ...(b.icon ? { icon: b.icon } : {}),
        haystack: `${b.label} ${b.tooltip ?? ''}`.toLowerCase(),
        run: () => b.onClick(api),
      });
    }

    const tables = await api.store.tables.find({ workspaceId: ctx.workspaceId });
    tables.sort((a, b) => a.name.localeCompare(b.name));
    for (const t of tables) {
      items.push({
        id: `goto:${t.id}`,
        title: `Go to: ${t.name}`,
        group: 'Tables',
        icon: 'table_chart',
        haystack: `${t.name} go to table`.toLowerCase(),
        run: () => {
          focusTableWindow(t.id);
        },
      });
    }

    const views = await api.store.viewInstances.find({ workspaceId: ctx.workspaceId });
    views.sort((a, b) => a.name.localeCompare(b.name));
    for (const v of views) {
      items.push({
        id: `goto-view:${v.id}`,
        title: `Go to view: ${v.name}`,
        group: 'Views',
        icon: 'view_quilt',
        haystack: `${v.name} go to view`.toLowerCase(),
        run: async () => {
          // One call for both cases: opens a closed view and fronts an already
          // open one. Patching `open` and fronting straight after used to miss
          // the closed case — the panel is created by the store subscription,
          // which had not run yet, so there was nothing to front.
          await revealViewWindow(v.id);
        },
      });
    }

    // Stable sort by group rank; within-group insertion order is preserved.
    // The recent commands are moved to the front first, so that order also
    // decides their order inside the "Recent" group (which ranks first).
    return orderByRecent(items, this.recentIds)
      .map((it, i) => ({ it, i }))
      .sort((a, b) => groupRank(a.it.group) - groupRank(b.it.group) || a.i - b.i)
      .map(({ it }) => it);
  }

  private get filtered(): PaletteItem[] {
    const raw = this.search.trim();
    if (!raw) return this.items;
    const hits = this.items.filter((it) => it.haystack.includes(raw.toLowerCase()));
    return hits.length > 0 ? hits : this.fallbackItems(raw);
  }

  /**
   * What a registered fallback offers for a query nothing matched. This is how
   * the palette accepts text it could not have listed in advance — a commandlet
   * the user typed, say — without knowing what one is.
   */
  private fallbackItems(query: string): PaletteItem[] {
    const api = this.api;
    if (!api) return [];
    const specs: PaletteItem[] = [];
    for (const fn of this.commandFallbacks) {
      let spec;
      try {
        spec = fn(query);
      } catch {
        continue; // a broken provider must not empty the palette
      }
      if (!spec) continue;
      specs.push({
        id: spec.id,
        title: spec.title,
        group: spec.group ?? 'Commands',
        ...(spec.icon ? { icon: spec.icon } : {}),
        haystack: spec.title.toLowerCase(),
        run: () => spec.run(api),
      });
    }
    return specs;
  }

  private close(): void {
    this.dialogEl?.close();
  }

  private onInput(e: Event): void {
    this.search = (e.target as HTMLInputElement).value;
    this.selected = 0;
  }

  private onKeydown(e: KeyboardEvent): void {
    const items = this.filtered;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      this.selected = items.length ? (this.selected + 1) % items.length : 0;
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      this.selected = items.length ? (this.selected - 1 + items.length) % items.length : 0;
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const item = items[this.selected];
      if (item) void this.execute(item);
    }
    // Escape is handled natively by <dialog> (cancel → close).
  }

  /**
   * Close on a backdrop click. A modal `<dialog>` reports such a click as a
   * click on the dialog element itself, so the hit test compares the pointer
   * against the dialog's box instead of trusting `event.target`.
   */
  private onDialogClick = (e: MouseEvent): void => {
    // A keyboard-synthesized click (detail 0) carries no coordinates, which
    // would read as (0,0) — outside the box — and close the palette.
    if (e.detail === 0 || !this.dialogEl) return;
    const r = this.dialogEl.getBoundingClientRect();
    const inside = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
    if (!inside) this.close();
  };

  private async execute(item: PaletteItem): Promise<void> {
    this.close();
    // Remember BEFORE running: a command that opens a dialog only resolves once
    // the user is done with it, and a command that throws was still the last
    // thing the user asked for. NOT awaited — the command must start on this
    // tick, not after a round trip to IndexedDB.
    void this.remember(item.id);
    try {
      await item.run();
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[command:${item.id}]`, err);
    }
  }

  /**
   * Forget remembered ids that no longer resolve, writing the shorter list back.
   * Silent when nothing changed, so opening the palette is not a store write.
   */
  private async forgetVanished(): Promise<void> {
    const kept = pruneRecent(
      this.recentIds,
      this.items.map((it) => it.id),
    );
    if (kept.length === this.recentIds.length) return;
    this.recentIds = kept;
    try {
      await this.api?.store.settings.upsert({ name: RECENT_SETTING, value: kept });
    } catch {
      // Cosmetic: the list is already pruned in memory for this open.
    }
  }

  /** Records `id` as the most recent command, for the next open(). */
  private async remember(id: string): Promise<void> {
    this.recentIds = pushRecent(this.recentIds, id);
    try {
      await this.api?.store.settings.upsert({ name: RECENT_SETTING, value: this.recentIds });
    } catch (err) {
      // A palette that cannot write its history still has to run the command.
      // eslint-disable-next-line no-console
      console.warn('[command-palette] could not save recent commands', err);
    }
  }

  override render() {
    const items = this.filtered;
    let lastGroup = '';
    return html`
      <dialog @keydown=${this.onKeydown} @click=${this.onDialogClick} @close=${() => (this.search = '')}>
        <div class="search-row">
          <span class="mi">search</span>
          <input type="text" placeholder="Type a command…  (windows, go to, import, export)" .value=${this.search} @input=${this.onInput} />
        </div>
        <div class="list">
          ${items.length === 0
            ? html`<div class="empty">No matching commands.</div>`
            : items.map((it, i) => {
                const header = it.group !== lastGroup ? ((lastGroup = it.group), it.group) : null;
                return html`
                  ${header ? html`<div class="group-head">${header}</div>` : ''}
                  <div class=${`item${i === this.selected ? ' sel' : ''}`} @mousemove=${() => (this.selected = i)} @click=${() => this.execute(it)}>
                    ${renderIcon(it.icon)}
                    <span class="title">${it.title}</span>
                  </div>
                `;
              })}
        </div>
      </dialog>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'command-palette-dialog': CommandPaletteDialog;
  }
}
