import { LitElement, css, html } from 'lit';
import { customElement, query, state } from 'lit/decorators.js';
import { unsafeSVG } from 'lit/directives/unsafe-svg.js';
import type { CommandSpec, HostApi } from '@easydb/shared';
import { getContext } from '../app-context.js';
import { materialIconStyles } from '../chrome/material-icon-css.js';
import { focusTableWindow } from '../window-mgr/jspanel-manager.js';

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
const GROUP_RANK: Record<string, number> = { Windows: 0, Actions: 1, App: 2, Tables: 3 };
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
 * Enter to run, Esc to close.
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

  async open(): Promise<void> {
    const ctx = await getContext();
    this.api = ctx.api;
    this.items = await this.buildItems();
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

    // Stable sort by group rank; within-group insertion order is preserved.
    return items
      .map((it, i) => ({ it, i }))
      .sort((a, b) => groupRank(a.it.group) - groupRank(b.it.group) || a.i - b.i)
      .map(({ it }) => it);
  }

  private get filtered(): PaletteItem[] {
    const q = this.search.trim().toLowerCase();
    if (!q) return this.items;
    return this.items.filter((it) => it.haystack.includes(q));
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

  private async execute(item: PaletteItem): Promise<void> {
    this.close();
    try {
      await item.run();
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[command:${item.id}]`, err);
    }
  }

  override render() {
    const items = this.filtered;
    let lastGroup = '';
    return html`
      <dialog @keydown=${this.onKeydown} @close=${() => (this.search = '')}>
        <div class="search-row">
          <span class="mi">search</span>
          <input
            type="text"
            placeholder="Type a command…  (windows, go to, import, export)"
            .value=${this.search}
            @input=${this.onInput}
          />
        </div>
        <div class="list">
          ${items.length === 0
            ? html`<div class="empty">No matching commands.</div>`
            : items.map((it, i) => {
                const header = it.group !== lastGroup ? ((lastGroup = it.group), it.group) : null;
                return html`
                  ${header ? html`<div class="group-head">${header}</div>` : ''}
                  <div
                    class=${`item${i === this.selected ? ' sel' : ''}`}
                    @mousemove=${() => (this.selected = i)}
                    @click=${() => this.execute(it)}
                  >
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
