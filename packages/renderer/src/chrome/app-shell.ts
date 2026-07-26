import type { ButtonSpec, HostApi } from '@easydb/shared';
import { LitElement, css, html } from 'lit';
import { customElement, query, state } from 'lit/decorators.js';
import { unsafeSVG } from 'lit/directives/unsafe-svg.js';
import { getContext } from '../app-context.js';
import '../dialogs/csv-paste-dialog.js';
import type { CsvPasteDialog } from '../dialogs/csv-paste-dialog.js';
import '../dialogs/host-dialogs.js';
import '../dialogs/new-table-dialog.js';
import type { NewTableDialog } from '../dialogs/new-table-dialog.js';
import '../dialogs/plugin-manager-dialog.js';
import type { PluginManagerDialog } from '../dialogs/plugin-manager-dialog.js';
import '../dialogs/settings-dialog.js';
import type { SettingsDialog } from '../dialogs/settings-dialog.js';
import '../dialogs/script-editor-dialog.js';
import '../dialogs/toast-host.js';
import { materialIconStyles } from './material-icon-css.js';
import './table-list.js';
import './workspace-selector.js';

/**
 * Render a button's `icon`. An icon string that begins with `<svg` is rendered
 * as inline SVG (sized + coloured by CSS); anything else is treated as a
 * Material Icons ligature name, the long-standing default.
 */
function renderButtonIcon(icon: string | undefined) {
  if (!icon) return '';
  if (icon.trimStart().startsWith('<svg')) {
    return html`<span class="icon-svg">${unsafeSVG(icon)}</span>`;
  }
  return html`<span class="mi sm">${icon}</span>`;
}

@customElement('app-shell')
export class AppShell extends LitElement {
  static override styles = [
    materialIconStyles,
    css`
      :host {
        display: flex;
        flex-direction: column;
        height: 100vh;
        font-family: system-ui, sans-serif;
        background: #f3f4f6;
      }
      header,
      footer {
        background: #1f2937;
        color: white;
        padding: 0.5rem 1rem;
        display: flex;
        align-items: center;
        gap: 0.75rem;
        position: relative;
        z-index: 100000;
      }
      header strong,
      footer .spacer {
        flex: 1;
      }
      footer button.slot {
        background: transparent;
        color: white;
        border: 1px solid #4b5563;
        padding: 0.3rem 0.7rem;
        border-radius: 0.25rem;
        cursor: pointer;
        font: inherit;
      }
      footer button.slot:hover {
        background: #374151;
      }
      header .version-link {
        color: inherit;
        text-decoration: none;
        cursor: pointer;
      }
      header .version-link:hover .version {
        opacity: 1;
        text-decoration: underline;
      }
      header .version {
        opacity: 0.5;
        font-size: 0.75rem;
        margin-left: 0.5rem;
      }
      button.primary,
      button.slot {
        display: inline-flex;
        align-items: center;
        gap: 0.35rem;
      }
      button.primary {
        background: #3b82f6;
        color: white;
        border: 0;
        padding: 0.4rem 0.75rem;
        border-radius: 0.25rem;
        cursor: pointer;
        font: inherit;
      }
      button.primary:hover {
        background: #2563eb;
      }
      .search-wrap {
        position: relative;
        display: inline-flex;
        align-items: center;
      }
      input.search {
        background: #374151;
        color: white;
        border: 1px solid #4b5563;
        padding: 0.3rem 1.7rem 0.3rem 0.6rem;
        border-radius: 0.25rem;
        font: inherit;
        width: 14rem;
      }
      input.search::placeholder {
        color: #9ca3af;
      }
      input.search:focus {
        outline: 2px solid #3b82f6;
        outline-offset: -1px;
      }
      /* Hide the browser's native search clear glyph — we render our own × so
         it's visible on the dark header and works in every browser. */
      input.search::-webkit-search-cancel-button {
        -webkit-appearance: none;
        appearance: none;
      }
      .search-clear {
        position: absolute;
        right: 0.3rem;
        top: 50%;
        transform: translateY(-50%);
        background: transparent;
        border: 0;
        color: #9ca3af;
        cursor: pointer;
        font-size: 1.1rem;
        line-height: 1;
        padding: 0 0.2rem;
      }
      .search-clear:hover {
        color: white;
      }
      button.icon-btn {
        background: transparent;
        color: white;
        border: 1px solid #4b5563;
        padding: 0.3rem 0.6rem;
        border-radius: 0.25rem;
        font: inherit;
        cursor: pointer;
        line-height: 1;
      }
      button.icon-btn:hover {
        background: #374151;
      }
      /* Highlight the collapsed search icon while a global filter is active, so
         a live search stays discoverable after the box collapses. */
      button.icon-btn.active {
        color: #93c5fd;
        border-color: #3b82f6;
      }
      /* Inline-SVG button icons (icon strings that start with "<svg"). The svg
         inherits the button's text colour via fill/stroke: currentColor. */
      .icon-svg {
        display: inline-flex;
        align-items: center;
      }
      .icon-svg svg {
        width: 1.05rem;
        height: 1.05rem;
        display: block;
      }
      main {
        flex: 1;
        overflow: hidden;
        position: relative;
      }
      :host(.drag-over) main::after {
        content: 'Drop CSV or JSON here';
        position: absolute;
        inset: 0.75rem;
        border: 3px dashed #3b82f6;
        border-radius: 0.75rem;
        display: grid;
        place-items: center;
        background: rgba(59, 130, 246, 0.12);
        color: #1e3a8a;
        font-weight: 700;
        font-size: 1.6rem;
        letter-spacing: 0.04em;
        pointer-events: none;
        z-index: 90000;
        animation: pulse-overlay 1.4s ease-in-out infinite;
      }
      @keyframes pulse-overlay {
        0%,
        100% {
          background: rgba(59, 130, 246, 0.08);
        }
        50% {
          background: rgba(59, 130, 246, 0.18);
        }
      }
      /* Mobile / narrow: the header wraps. The app name + version take their
         own line; the buttons wrap below as icon-only chips (labels hidden on
         any button that carries an icon, so nothing goes blank). */
      @media (max-width: 640px) {
        header {
          flex-wrap: wrap;
          row-gap: 0.4rem;
        }
        header > strong {
          flex: 1 0 100%;
        }
        input.search {
          width: 100%;
        }
        button.primary:has(.icon-svg) .btn-label,
        button.primary:has(.mi) .btn-label,
        button.slot:has(.icon-svg) .btn-label,
        button.slot:has(.mi) .btn-label {
          display: none;
        }
      }
    `,
  ];

  @query('new-table-dialog') private dialog!: NewTableDialog;
  @query('csv-paste-dialog') private csvPasteDialog!: CsvPasteDialog;
  @query('plugin-manager-dialog') private pluginManagerDialog!: PluginManagerDialog;
  @query('settings-dialog') private settingsDialog!: SettingsDialog;
  @query('input.search') private searchInput?: HTMLInputElement;
  @state() private footerButtons: ButtonSpec[] = [];
  @state() private headerButtons: ButtonSpec[] = [];
  @state() private searchQuery = '';
  @state() private searchOpen = false;
  @state() private workspaceTitle = '';
  private api: HostApi | null = null;
  private searchTimer: number | null = null;
  private workspaceUnsub?: () => void;
  // Set when the search box opens so `updated()` focuses the freshly-rendered
  // input exactly once. `autofocus` is unreliable — it only fires on initial
  // document parse, not when Lit inserts the input on click.
  private searchFocusPending = false;

  override connectedCallback() {
    super.connectedCallback();
    this.addEventListener('dragover', this.onDragOver);
    this.addEventListener('dragleave', this.onDragLeave);
    this.addEventListener('drop', this.onDrop);
    // Panels live in light DOM (#easydb-panels), outside this shell's shadow,
    // so we listen on the document root to receive their bubbling events.
    document.addEventListener('easydb:edit-columns', this.onEditColumns as EventListener);
    document.addEventListener('easydb:open-new-table', this.onOpenNewTable);
    document.addEventListener('easydb:open-csv-paste', this.onOpenCsvPaste);
    document.addEventListener('easydb:open-plugin-manager', this.onOpenPluginManager);
    document.addEventListener('easydb:open-settings', this.onOpenSettings);
    void this.bindRegistries();
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this.removeEventListener('dragover', this.onDragOver);
    this.removeEventListener('dragleave', this.onDragLeave);
    this.removeEventListener('drop', this.onDrop);
    document.removeEventListener('easydb:edit-columns', this.onEditColumns as EventListener);
    document.removeEventListener('easydb:open-new-table', this.onOpenNewTable);
    document.removeEventListener('easydb:open-csv-paste', this.onOpenCsvPaste);
    document.removeEventListener('easydb:open-plugin-manager', this.onOpenPluginManager);
    document.removeEventListener('easydb:open-settings', this.onOpenSettings);
    this.workspaceUnsub?.();
  }

  private onEditColumns = (e: Event) => {
    const ce = e as CustomEvent<{ tableId: string; notice?: string }>;
    void this.dialog?.open(ce.detail.tableId, { notice: ce.detail.notice });
  };

  private onOpenNewTable = () => {
    void this.dialog?.open();
  };

  private onOpenCsvPaste = () => {
    void this.csvPasteDialog?.open();
  };

  private onOpenPluginManager = () => {
    void this.pluginManagerDialog?.open();
  };

  private onOpenSettings = () => {
    void this.settingsDialog?.open();
  };

  private openSearch = () => {
    this.searchOpen = true;
    this.searchFocusPending = true;
  };

  // Clicking outside the input blurs it; collapse back to the icon. Any active
  // query is preserved (the collapsed icon shows the highlighted state) so the
  // global filter keeps applying.
  private closeSearchOnBlur = () => {
    this.searchOpen = false;
  };

  override updated() {
    if (this.searchFocusPending && this.searchInput) {
      this.searchInput.focus();
      this.searchFocusPending = false;
    }
  }

  // Broadcast to every <data-table> in any panel; they filter their own rows.
  // We deliberately do NOT hide panels — keep the workspace layout stable so
  // the user can scan multiple tables at once.
  private broadcastSearch(query: string) {
    document.dispatchEvent(new CustomEvent('easydb:global-search', { detail: { query } }));
  }

  private onSearchInput = (e: Event) => {
    this.searchQuery = (e.target as HTMLInputElement).value;
    if (this.searchTimer != null) window.clearTimeout(this.searchTimer);
    this.searchTimer = window.setTimeout(() => this.broadcastSearch(this.searchQuery), 200);
  };

  // Clear button (×) inside the search box. `mousedown` is prevented so the
  // input doesn't blur (which would collapse the box); the query is cleared and
  // the empty filter broadcast immediately, and focus stays in the input.
  private clearSearch = (e: Event) => {
    e.preventDefault();
    if (this.searchTimer != null) window.clearTimeout(this.searchTimer);
    this.searchQuery = '';
    this.broadcastSearch('');
    this.searchFocusPending = true;
  };

  private async bindRegistries() {
    const ctx = await getContext();
    this.api = ctx.api;
    // Snapshot now, then re-snapshot when app:ready fires (built-ins register
    // during load(), which runs after init resolves).
    this.snapshotRegistries(ctx);
    ctx.events.on('app:ready', () => this.snapshotRegistries(ctx));
    // Live-update the header title as the Settings dialog edits it — no reload needed.
    this.workspaceUnsub = ctx.store.workspaces.subscribe((all) => {
      const me = all.find((w) => w.id === ctx.workspaceId);
      this.workspaceTitle = me?.title?.trim() ?? '';
    });
  }

  private snapshotRegistries(ctx: {
    registries: { footerButtons: ButtonSpec[]; headerButtons: ButtonSpec[] };
  }) {
    this.footerButtons = [...ctx.registries.footerButtons];
    this.headerButtons = [...ctx.registries.headerButtons];
  }

  private onDragOver = (e: DragEvent) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    this.classList.add('drag-over');
  };

  private onDragLeave = (e: DragEvent) => {
    if (e.relatedTarget && this.contains(e.relatedTarget as Node)) return;
    this.classList.remove('drag-over');
  };

  private onDrop = async (e: DragEvent) => {
    this.classList.remove('drag-over');
    if (!hasFiles(e)) return;
    e.preventDefault();
    const ctx = await getContext();
    const files = Array.from(e.dataTransfer?.files ?? []);
    ctx.events.emit('drop:files', { files, event: e });
    for (const fn of [...ctx.registries.dropHandlers]) {
      try {
        const handled = await fn(e, ctx.api);
        if (handled) return;
      } catch (err) {
        ctx.events.emit('plugin:error', {
          url: '(drop-handler)',
          phase: 'runtime',
          error: err,
        });
      }
    }
  };

  private runSlot = (spec: ButtonSpec, e?: Event) => {
    if (!this.api) return;
    // Capture the clicked element NOW — currentTarget is null after the await —
    // so anchored menus (gist/export/sync) open under the button, not the
    // bottom-left fallback.
    const anchor = (e?.currentTarget as HTMLElement | undefined) ?? undefined;
    void Promise.resolve(spec.onClick(this.api, { anchor })).catch((err) => {
      // eslint-disable-next-line no-console
      console.error(`[footer-button:${spec.id}]`, err);
    });
  };

  private renderSlotButton(b: ButtonSpec, where: 'header' | 'footer') {
    // `secondary` renders as a muted icon-only button (no label), used for
    // utility actions like Settings. Otherwise header buttons get the primary
    // treatment; the footer distinguishes primary vs slot.
    if (b.variant === 'secondary') {
      return html`
        <button class="icon-btn" title=${b.tooltip ?? b.label} @click=${() => this.runSlot(b)}>
          ${renderButtonIcon(b.icon)}
        </button>
      `;
    }
    const cls = where === 'header' || b.variant === 'primary' ? 'primary' : 'slot';
    return html`
      <button class=${cls} title=${b.tooltip ?? b.label} @click=${(e: Event) => this.runSlot(b, e)}>
        ${renderButtonIcon(b.icon)}
        <span class="btn-label">${b.label}</span>
      </button>
    `;
  }

  override render() {
    return html`
      <header>
        <strong
          >${this.workspaceTitle || 'easyDBAccess'}
          <a
            class="version-link"
            href="https://github.com/cawoodm/easydbaccess/blob/main/CHANGELOG.md"
            target="_blank"
            rel="noopener"
            title="View the changelog on GitHub"
            ><span class="version">v0.0.124</span></a
          ></strong
        >
        ${this.headerButtons
          .filter((b) => b.variant !== 'secondary')
          .map((b) => this.renderSlotButton(b, 'header'))}
        ${this.searchOpen
          ? html`<span class="search-wrap">
              <input
                class="search"
                type="search"
                placeholder="search all tables…"
                .value=${this.searchQuery}
                @input=${this.onSearchInput}
                @blur=${this.closeSearchOnBlur}
              />
              ${this.searchQuery.length > 0
                ? html`<button
                    class="search-clear"
                    title="Clear search"
                    aria-label="Clear search"
                    @mousedown=${this.clearSearch}
                  >
                    ×
                  </button>`
                : ''}
            </span>`
          : html`<button
              class="icon-btn ${this.searchQuery.trim().length > 0 ? 'active' : ''}"
              title=${this.searchQuery.trim().length > 0
                ? `Filtering all tables: ${this.searchQuery}`
                : 'Search across all tables in this workspace'}
              @click=${this.openSearch}
            >
              <span class="mi">search</span>
            </button>`}
        <button
          class="icon-btn"
          title="Add, disable, or remove plugins"
          @click=${() => this.api?.ui.openPluginManager()}
        >
          <span class="mi">extension</span>
        </button>
        ${this.headerButtons
          .filter((b) => b.variant === 'secondary')
          .map((b) => this.renderSlotButton(b, 'header'))}
      </header>
      <main><table-list></table-list></main>
      <footer>
        <workspace-selector></workspace-selector>
        <span class="spacer"></span>
        ${this.footerButtons.map((b) => this.renderSlotButton(b, 'footer'))}
      </footer>
      <new-table-dialog></new-table-dialog>
      <csv-paste-dialog></csv-paste-dialog>
      <plugin-manager-dialog></plugin-manager-dialog>
      <settings-dialog></settings-dialog>
      <script-editor-dialog></script-editor-dialog>
      <host-dialogs></host-dialogs>
      <toast-host></toast-host>
    `;
  }
}

function hasFiles(e: DragEvent): boolean {
  const dt = e.dataTransfer;
  if (!dt) return false;
  if (dt.types && Array.from(dt.types).includes('Files')) return true;
  return (dt.files?.length ?? 0) > 0;
}

declare global {
  interface HTMLElementTagNameMap {
    'app-shell': AppShell;
  }
}
