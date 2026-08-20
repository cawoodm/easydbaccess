import type { ButtonSpec, HostApi } from '@easydb/shared';
import { LitElement, css, html, nothing } from 'lit';
import { customElement, query, state } from 'lit/decorators.js';
import { unsafeSVG } from 'lit/directives/unsafe-svg.js';
import { defineHostDialogs } from '@marccawood/lit-dialogs';
import { defineToastHost } from '@marccawood/lit-toast';
import { getContext } from '../app-context.js';
import { hasColumnDrag } from '../table/column-drag.js';
import { CHROME_SETTINGS_ID, CHROME_SETTINGS_NAME, chromeSettingsFields, readButtonText, readHiddenButtons } from './chrome-settings.js';
import { SETTINGS_CHANGED_EVENT, type SettingsChangedDetail } from '../db/settings-events.js';
import '../dialogs/csv-paste-dialog.js';
import type { CsvPasteDialog } from '../dialogs/csv-paste-dialog.js';
import '../dialogs/new-table-dialog.js';
import type { NewTableDialog } from '../dialogs/new-table-dialog.js';
import '../dialogs/plugin-manager-dialog.js';
import type { PluginManagerDialog } from '../dialogs/plugin-manager-dialog.js';
import '../dialogs/settings-dialog.js';
import type { SettingsDialog } from '../dialogs/settings-dialog.js';
import '../dialogs/command-palette-dialog.js';
import type { CommandPaletteDialog } from '../dialogs/command-palette-dialog.js';
import '../dialogs/script-editor-dialog.js';
import { materialIconStyles } from './material-icon-css.js';
import './app-progress.js';
import './table-list.js';
import './workspace-selector.js';

// Both extracted elements register on demand, not on import — they are
// libraries and a repeated import must not throw. The shell's template below
// renders both, so they have to be defined before it runs.
defineHostDialogs();
defineToastHost();

/**
 * Marks the table window a drop would land in. Styled in
 * `window-mgr/panel-shell/panel-shell.css`, not here: a panel lives in light DOM
 * under `#easydb-panels`, outside this shell's shadow root, so this shell cannot
 * style it.
 */
const DROP_TARGET_CLASS = 'eda-drop-target';

/**
 * Render a button's `icon`. An icon string that begins with `<svg` is rendered
 * as inline SVG (sized + coloured by CSS); anything else is treated as a
 * Material Icons ligature name, the long-standing default.
 *
 * Both branches are `aria-hidden`: a Material Icons glyph IS its ligature text,
 * so an unhidden icon span joins the button's accessible name — a screen reader
 * (and `getByRole('button', { name })`) saw "cloud_sync Sync" instead of "Sync".
 * The label next to it carries the meaning.
 */
function renderButtonIcon(icon: string | undefined) {
  if (!icon) return '';
  if (icon.trimStart().startsWith('<svg')) {
    return html`<span class="icon-svg" aria-hidden="true">${unsafeSVG(icon)}</span>`;
  }
  return html`<span class="mi sm" aria-hidden="true">${icon}</span>`;
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
      /* The attention dot (ButtonSpec.badge) sits in the button's corner, half
         outside it, the way an unread count does. No backticks in here: this is a
         tagged template literal and one would end it. */
      button.primary:has(.badge),
      button.slot:has(.badge),
      button.icon-btn:has(.badge) {
        position: relative;
      }
      .badge {
        position: absolute;
        top: -3px;
        right: -3px;
        width: 9px;
        height: 9px;
        border-radius: 50%;
        background: #ef4444;
        /* A ring in the header's own colour, so the dot reads as a separate mark
           rather than a smudge on the button's edge. */
        box-shadow: 0 0 0 2px #1f2937;
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
      button.icon-btn,
      a.icon-btn {
        background: transparent;
        color: white;
        border: 1px solid #4b5563;
        padding: 0.3rem 0.6rem;
        border-radius: 0.25rem;
        font: inherit;
        cursor: pointer;
        line-height: 1;
        /* a.icon-btn is a link, not a button — strip the underline/default
           link colour so it renders identically to its button siblings. */
        text-decoration: none;
        display: inline-flex;
        align-items: center;
      }
      button.icon-btn:hover,
      a.icon-btn:hover {
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
  @query('command-palette-dialog') private commandPaletteDialog!: CommandPaletteDialog;
  @query('input.search') private searchInput?: HTMLInputElement;
  @state() private footerButtons: ButtonSpec[] = [];
  @state() private headerButtons: ButtonSpec[] = [];
  /** Do the bars show button labels? See `chrome-settings.ts`. */
  @state() private headerButtonText = true;
  @state() private footerButtonText = true;
  /** Button ids the user switched off, per bar. */
  @state() private hiddenHeaderButtons: ReadonlySet<string> = new Set();
  @state() private hiddenFooterButtons: ReadonlySet<string> = new Set();
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
    // On the DOCUMENT, not on this element: the floating windows live in
    // `#easydb-panels`, which is a SIBLING of <app-shell>, so a file dropped on a
    // table window never bubbled here at all — the browser just navigated away
    // to the dropped file. The drag-over highlight still belongs to the shell.
    document.addEventListener('dragover', this.onDragOver);
    document.addEventListener('dragleave', this.onDragLeave);
    document.addEventListener('drop', this.onDrop);
    // Panels live in light DOM (#easydb-panels), outside this shell's shadow,
    // so we listen on the document root to receive their bubbling events.
    document.addEventListener('easydb:edit-columns', this.onEditColumns as EventListener);
    document.addEventListener('easydb:open-new-table', this.onOpenNewTable);
    document.addEventListener('easydb:open-csv-paste', this.onOpenCsvPaste);
    document.addEventListener('easydb:open-plugin-manager', this.onOpenPluginManager);
    document.addEventListener('easydb:open-settings', this.onOpenSettings);
    document.addEventListener('easydb:open-export', this.onOpenExport as EventListener);
    document.addEventListener('easydb:open-command-palette', this.onOpenCommandPalette);
    document.addEventListener('easydb:focus-search', this.openSearch);
    document.addEventListener('easydb:set-search', this.onSetSearch as EventListener);
    document.addEventListener('keydown', this.onGlobalKeydown);
    document.addEventListener(SETTINGS_CHANGED_EVENT, this.onSettingsChanged);
    // Resolved once, not per `dragover`: that event fires continuously while a file
    // moves, and the window manager is loaded at boot by the table list anyway. A
    // dynamic import keeps the chrome from depending on the window layer statically,
    // the same way the drop handlers do.
    void import('../window-mgr/table-window-manager.js').then((m) => (this.tablePanelAt = m.tablePanelAtNode));
    void this.bindRegistries();
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    document.removeEventListener('dragover', this.onDragOver);
    document.removeEventListener('dragleave', this.onDragLeave);
    document.removeEventListener('drop', this.onDrop);
    document.removeEventListener('easydb:edit-columns', this.onEditColumns as EventListener);
    document.removeEventListener('easydb:open-new-table', this.onOpenNewTable);
    document.removeEventListener('easydb:open-csv-paste', this.onOpenCsvPaste);
    document.removeEventListener('easydb:open-plugin-manager', this.onOpenPluginManager);
    document.removeEventListener('easydb:open-settings', this.onOpenSettings);
    document.removeEventListener('easydb:open-export', this.onOpenExport as EventListener);
    document.removeEventListener('easydb:open-command-palette', this.onOpenCommandPalette);
    document.removeEventListener('easydb:focus-search', this.openSearch);
    document.removeEventListener('easydb:set-search', this.onSetSearch as EventListener);
    document.removeEventListener('easydb:refresh-buttons', this.onRefreshButtons);
    document.removeEventListener('keydown', this.onGlobalKeydown);
    document.removeEventListener(SETTINGS_CHANGED_EVENT, this.onSettingsChanged);
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

  /**
   * The export dialog mounts itself on demand, so the shell only forwards the
   * request. Loaded lazily: it pulls in the table selector and the export
   * pipeline, and most sessions never export anything.
   */
  private onOpenExport = (e: Event) => {
    const ids = (e as CustomEvent<{ tableIds?: string[] }>).detail?.tableIds;
    void import('../dialogs/export-dialog.js').then((m) => m.openExport(ids));
  };

  private onOpenCommandPalette = () => {
    void this.commandPaletteDialog?.open();
  };

  // Global Ctrl+K / Cmd+K opens the command palette.
  private onGlobalKeydown = (e: KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && !e.altKey && (e.key === 'k' || e.key === 'K')) {
      e.preventDefault();
      void this.commandPaletteDialog?.open();
    }
  };

  private openSearch = () => {
    this.searchOpen = true;
    this.searchFocusPending = true;
  };

  /**
   * Set the global query from outside — a `search/…` commandlet. It goes through
   * the box rather than broadcasting directly, so the rows and the field the
   * user is looking at never disagree about what is being searched for.
   */
  private onSetSearch = (e: CustomEvent<{ query: string }>) => {
    this.searchQuery = e.detail?.query ?? '';
    if (this.searchTimer != null) window.clearTimeout(this.searchTimer);
    if (this.searchQuery) this.searchOpen = true;
    this.broadcastSearch(this.searchQuery);
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
    // A button whose LABEL changes while the app runs — the File plugin's Save and
    // its unsaved marker. A `ButtonSpec` is a plain object the plugin owns, so the
    // plugin edits its own spec and asks for a re-render here; without this the
    // snapshot array keeps its identity and Lit has no reason to render again.
    this.refreshButtons = () => this.snapshotRegistries(ctx);
    document.addEventListener('easydb:refresh-buttons', this.onRefreshButtons);
    // Live-update the header title as the Settings dialog edits it — no reload needed.
    this.workspaceUnsub = ctx.store.workspaces.subscribe((all) => {
      const me = all.find((w) => w.id === ctx.workspaceId);
      this.workspaceTitle = me?.title?.trim() ?? '';
      syncDocumentTitle(this.workspaceTitle);
    });
  }

  private snapshotRegistries(ctx: { api: HostApi; registries: { footerButtons: ButtonSpec[]; headerButtons: ButtonSpec[] } }) {
    this.footerButtons = [...ctx.registries.footerButtons];
    this.headerButtons = [...ctx.registries.headerButtons];
    void this.syncChromeSettings(ctx.api);
  }

  /**
   * Publish the Buttons settings tab and read back what it says.
   *
   * Re-registering replaces the tab (the registry is keyed by id), and it has to
   * run on every snapshot: a plugin installed from the Plugin Manager brings its
   * own button, which needs its own switch without a reload.
   */
  private async syncChromeSettings(api: HostApi) {
    api.ui.registerSettings(CHROME_SETTINGS_ID, CHROME_SETTINGS_NAME, chromeSettingsFields(this.headerButtons, this.footerButtons));
    await this.readChromeSettings(api);
  }

  private async readChromeSettings(api: HostApi) {
    this.headerButtonText = await readButtonText(api.settings, 'header');
    this.footerButtonText = await readButtonText(api.settings, 'footer');
    this.hiddenHeaderButtons = await readHiddenButtons(
      api.settings,
      'header',
      this.headerButtons.map((b) => b.id),
    );
    this.hiddenFooterButtons = await readHiddenButtons(
      api.settings,
      'footer',
      this.footerButtons.map((b) => b.id),
    );
  }

  /** The Settings dialog saves per field, so this is what makes a bar change
   *  while the dialog is still open. Ignores every other tab's writes. */
  private onSettingsChanged = (e: Event) => {
    const detail = (e as CustomEvent<SettingsChangedDetail>).detail;
    if (detail?.pluginId !== CHROME_SETTINGS_ID) return;
    if (this.api) void this.readChromeSettings(this.api);
  };

  /** Set once the registries are bound; before that there is nothing to refresh. */
  private refreshButtons: (() => void) | null = null;

  private onRefreshButtons = () => this.refreshButtons?.();

  /**
   * `tablePanelAtNode`, once the window manager has loaded. Null before that, which
   * only costs the per-table highlight for the first moments after boot.
   */
  private tablePanelAt: ((node: EventTarget | null) => HTMLElement | null) | null = null;
  /** The table window currently showing the drop highlight, if any. */
  private dropTargetPanel: HTMLElement | null = null;

  /**
   * Two drop targets, told apart while the file is still in the air.
   *
   * A drop on a table window LOADS that table; a drop anywhere else makes a new one.
   * Both were true before this, and the user could not tell which was about to
   * happen: one overlay covered the whole of `main`, table windows included, and
   * announced "Drop CSV or JSON here" over the very window whose own behaviour was
   * different. So the window under the pointer takes the highlight, and the
   * workspace overlay stands down while it has it.
   */
  private onDragOver = (e: DragEvent) => {
    const column = hasColumnDrag(e);
    if (!hasFiles(e) && !column) return;
    e.preventDefault();
    const panel = this.tablePanelAt?.(e.target) ?? null;
    this.setDropTargetPanel(panel);
    // A dragged COLUMN only has a meaning over another table's window. The
    // workspace overlay ("drop to make a new table") would be a lie for it, so
    // it never lights up for one.
    this.classList.toggle('drag-over', !column && panel === null);
  };

  private onDragLeave = (e: DragEvent) => {
    // Still inside the app (including the panels overlay, which is a SIBLING of
    // this element) ⇒ the drag has not left, it only crossed a boundary.
    const to = e.relatedTarget as Node | null;
    if (to && (this.contains(to) || panelsOverlay()?.contains(to))) return;
    this.classList.remove('drag-over');
    this.setDropTargetPanel(null);
  };

  /** Move the window highlight, keeping at most one window marked at a time. */
  private setDropTargetPanel(panel: HTMLElement | null): void {
    if (panel === this.dropTargetPanel) return;
    this.dropTargetPanel?.classList.remove(DROP_TARGET_CLASS);
    panel?.classList.add(DROP_TARGET_CLASS);
    this.dropTargetPanel = panel;
  }

  private onDrop = async (e: DragEvent) => {
    this.classList.remove('drag-over');
    this.setDropTargetPanel(null);
    const column = hasColumnDrag(e);
    if (!hasFiles(e) && !column) return;
    e.preventDefault();
    const ctx = await getContext();
    if (!column) {
      const files = Array.from(e.dataTransfer?.files ?? []);
      ctx.events.emit('drop:files', { files, event: e });
    }
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
    // The badge is markup, not text, so it cannot live in `label` — see
    // `ButtonSpec.badge`. `aria-hidden` on it: the tooltip already says what the
    // dot means, and a screen reader reading "•" says nothing.
    const badge = b.badge === true ? html`<span class="badge" aria-hidden="true"></span>` : '';
    if (b.variant === 'secondary') {
      return html` <button class="icon-btn" title=${b.tooltip ?? b.label} aria-label=${b.tooltip ?? b.label} @click=${() => this.runSlot(b)}>${renderButtonIcon(b.icon)}${badge}</button> `;
    }
    const cls = where === 'header' || b.variant === 'primary' ? 'primary' : 'slot';
    // Text off shows the icon alone — but only where there IS an icon, the same
    // rule the narrow-screen CSS follows, so a button never comes out blank.
    const showLabel = (where === 'header' ? this.headerButtonText : this.footerButtonText) || !b.icon;
    return html`
      <button class=${cls} title=${b.tooltip ?? b.label} @click=${(e: Event) => this.runSlot(b, e)}>
        ${renderButtonIcon(b.icon)} ${showLabel ? html`<span class="btn-label">${b.label}</span>` : nothing} ${badge}
      </button>
    `;
  }

  /** Buttons in one bar the user has not switched off. */
  private shownButtons(where: 'header' | 'footer'): ButtonSpec[] {
    const hidden = where === 'header' ? this.hiddenHeaderButtons : this.hiddenFooterButtons;
    const list = where === 'header' ? this.headerButtons : this.footerButtons;
    return list.filter((b) => !hidden.has(b.id));
  }

  override render() {
    return html`
      <header>
        <strong
          >${this.workspaceTitle || 'easyDBAccess'}
          <a class="version-link" href="https://github.com/cawoodm/easydbaccess/blob/main/CHANGELOG.md" target="_blank" rel="noopener" title="View the changelog on GitHub"
            ><span class="version">v0.0.408</span></a
          ></strong
        >
        ${this.shownButtons('header')
          .filter((b) => b.variant !== 'secondary')
          .map((b) => this.renderSlotButton(b, 'header'))}
        ${this.searchOpen
          ? html`<span class="search-wrap">
              <input class="search" type="search" placeholder="search all tables…" .value=${this.searchQuery} @input=${this.onSearchInput} @blur=${this.closeSearchOnBlur} />
              ${this.searchQuery.length > 0 ? html`<button class="search-clear" title="Clear search" aria-label="Clear search" @mousedown=${this.clearSearch}>×</button>` : ''}
            </span>`
          : html`<button
              class="icon-btn ${this.searchQuery.trim().length > 0 ? 'active' : ''}"
              title=${this.searchQuery.trim().length > 0 ? `Filtering all tables: ${this.searchQuery}` : 'Search across all tables in this workspace'}
              aria-label="Search"
              @click=${this.openSearch}
            >
              <span class="mi" aria-hidden="true">search</span>
            </button>`}
        <button class="icon-btn" title="Add, disable, or remove plugins" aria-label="Plugins" @click=${() => this.api?.ui.openPluginManager()}>
          <span class="mi" aria-hidden="true">extension</span>
        </button>
        <a
          class="icon-btn"
          href="https://github.com/cawoodm/easydbaccess/blob/main/docs/help/INDEX.md"
          target="_blank"
          rel="noopener noreferrer"
          title="Help — open the user guide"
          aria-label="Help — open the user guide"
        >
          <span class="mi" aria-hidden="true">help</span>
        </a>
        ${this.shownButtons('header')
          .filter((b) => b.variant === 'secondary')
          .map((b) => this.renderSlotButton(b, 'header'))}
      </header>
      <app-progress></app-progress>
      <main><table-list></table-list></main>
      <footer>
        <workspace-selector></workspace-selector>
        <span class="spacer"></span>
        ${this.shownButtons('footer').map((b) => this.renderSlotButton(b, 'footer'))}
      </footer>
      <new-table-dialog></new-table-dialog>
      <csv-paste-dialog></csv-paste-dialog>
      <plugin-manager-dialog></plugin-manager-dialog>
      <settings-dialog></settings-dialog>
      <command-palette-dialog></command-palette-dialog>
      <script-editor-dialog></script-editor-dialog>
      <host-dialogs></host-dialogs>
      <toast-host></toast-host>
    `;
  }
}

/**
 * The `<title>` shipped in index.html — "easyDBAccess v<version>", kept current
 * by scripts/bump-version.mjs. Captured before we touch it so it stays the base
 * every later title is built from (and the fallback when no workspace title is
 * set). Read at module load, which is before the shell can render.
 */
const BASE_DOCUMENT_TITLE = document.title;

/**
 * Put the workspace title in the browser tab, so several open workspaces are
 * tellable apart from the tab strip alone. The app name and version stay as the
 * suffix — they're what makes the tab identifiable as this app.
 */
function syncDocumentTitle(workspaceTitle: string): void {
  const t = workspaceTitle.trim();
  document.title = t ? `${t} — ${BASE_DOCUMENT_TITLE}` : BASE_DOCUMENT_TITLE;
}

/** The floating-window overlay — a sibling of `<app-shell>`, not a child. */
function panelsOverlay(): HTMLElement | null {
  return document.getElementById('easydb-panels');
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
