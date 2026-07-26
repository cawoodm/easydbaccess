import { LitElement, css, html } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { unsafeHTML } from 'lit/directives/unsafe-html.js';
import type { PluginRecord, PluginModule } from '@easydb/shared';
import { getContext } from '../app-context.js';
import { materialIconStyles } from '../chrome/material-icon-css.js';
import { ctrlEnterSubmits, dialogChromeStyles } from './dialog-chrome.js';
import { makeDialogDraggable } from './draggable.js';
import { builtinKey, builtinPlugins } from '../plugin-host/loader.js';

/** Small GitHub mark used for the "view source" link on rows with a `repo`. */
const GITHUB_ICON_SVG =
  '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 .5C5.37.5 0 5.87 0 12.5c0 5.3 3.44 9.8 8.21 11.39.6.11.82-.26.82-.58 0-.29-.01-1.04-.02-2.05-3.34.73-4.04-1.61-4.04-1.61-.55-1.39-1.34-1.76-1.34-1.76-1.09-.75.08-.73.08-.73 1.21.09 1.84 1.24 1.84 1.24 1.07 1.84 2.81 1.31 3.5 1 .11-.78.42-1.31.76-1.61-2.67-.3-5.47-1.34-5.47-5.95 0-1.31.47-2.39 1.24-3.23-.12-.3-.54-1.53.12-3.18 0 0 1.01-.32 3.3 1.23a11.5 11.5 0 0 1 6 0c2.29-1.55 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.77.84 1.24 1.92 1.24 3.23 0 4.62-2.81 5.64-5.49 5.94.43.37.81 1.1.81 2.22 0 1.6-.01 2.9-.01 3.29 0 .32.22.7.83.58A12.01 12.01 0 0 0 24 12.5C24 5.87 18.63.5 12 .5z"/></svg>';

/** Fallback icon (Material Icons "extension") for rows without a `meta.icon`. */
const FALLBACK_ICON = html`<span class="mi sm">extension</span>`;

/** Settings key persisting the list of catalog source URLs the user has used. */
const CATALOG_URLS_SETTING = 'plugin:catalogUrls';

function defaultCatalogUrl(): string {
  return new URL(`${import.meta.env.BASE_URL}plugins/catalog.json`, location.origin).toString();
}

interface CatalogEntry {
  id: string;
  name: string;
  description?: string;
  author?: string;
  icon?: string;
  repo?: string;
  /** Resolved against the catalog URL — may be relative (./foo.js) or absolute. */
  url: string;
}

interface CatalogResolved extends CatalogEntry {
  /** url resolved to an absolute URL — this is what goes into pluginUrls. */
  absUrl: string;
}

type Category = 'built-in' | 'available' | 'installed' | 'fixed';

/** Filter-toggle order + display labels, above the plugin list. */
const FILTER_LABELS: Array<[Category, string]> = [
  ['installed', 'Installed'],
  ['built-in', 'Built-in'],
  ['available', 'Available'],
  ['fixed', 'Fixed'],
];

/** One row of the unified plugin list, merged from built-ins / catalogs / installed URLs. */
interface PluginRow {
  id: string;
  name: string;
  /** True when `name` is just the raw URL (no catalog metadata is known for it). */
  urlOnly?: boolean;
  icon?: string;
  repo?: string;
  author?: string;
  /** Absolute install URL — present for anything that is (or could be) installed by URL. */
  url?: string;
  categories: Set<Category>;
  enabled: boolean;
  fixed?: boolean;
  installing?: boolean;
  /** Secondary line under the name — description, raw URL, fetch status, or an error. */
  meta?: string;
  metaIsError?: boolean;
}

/**
 * Lists every plugin the workspace knows about — built-in, available from a
 * catalog, and installed by URL — as one filterable, searchable list. Plugin
 * URLs live on Workspace.pluginUrls so they sync across devices; per-URL
 * state (cached body, enabled flag, last error) lives on the `plugins` Dexie
 * table; built-in enable state lives under the synthetic `builtin:<id>` key
 * in the same table.
 *
 * Toggling enable/disable applies on the next reload — hot-loading a plugin
 * would require unregistering its slot registrations and re-instantiating,
 * which the registry contract doesn't yet support. Installing a catalog
 * entry, however, hot-loads immediately (see `installFromCatalog`).
 */
@customElement('plugin-manager-dialog')
export class PluginManagerDialog extends LitElement {
  static override styles = [
    materialIconStyles,
    dialogChromeStyles,
    css`
      dialog {
        width: 720px;
        max-width: 94vw;
      }
      p.hint {
        margin: 0;
        color: #6b7280;
        font-size: 0.85rem;
      }

      .filters {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 1rem;
      }
      .filters .toggle-label {
        display: inline-flex;
        align-items: center;
        gap: 0.4rem;
        font-size: 0.85rem;
        color: #374151;
        cursor: pointer;
        user-select: none;
      }
      .search {
        flex: 1;
        min-width: 160px;
      }
      .search input {
        width: 100%;
        font: inherit;
        padding: 0.4rem 0.6rem;
        border: 1px solid #d1d5db;
        border-radius: 0.25rem;
        box-sizing: border-box;
      }

      .catalog-source {
        display: flex;
        gap: 0.4rem;
        align-items: center;
      }
      .catalog-source input {
        flex: 1;
        font: inherit;
        font-size: 0.85rem;
        padding: 0.35rem 0.5rem;
        border: 1px solid #d1d5db;
        border-radius: 0.25rem;
      }

      .plugin-list {
        display: flex;
        flex-direction: column;
        gap: 0.35rem;
        max-height: 42vh;
        overflow: auto;
      }
      .row {
        display: grid;
        grid-template-columns: 22px 1fr auto 22px 44px auto;
        gap: 0.6rem;
        align-items: center;
        padding: 0.45rem 0.6rem;
        border: 1px solid #e5e7eb;
        border-radius: 0.3rem;
        background: #f9fafb;
      }
      .row.builtin {
        background: #f3f4f6;
      }
      .row.error {
        background: #fef2f2;
        border-color: #fecaca;
      }
      .row-icon {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 20px;
        height: 20px;
        color: #6b7280;
      }
      .row-icon svg {
        width: 100%;
        height: 100%;
      }
      .row-main {
        min-width: 0;
      }
      .row-title {
        font-weight: 600;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .row-title.mono {
        font-family: ui-monospace, SFMono-Regular, monospace;
        font-weight: 400;
        font-size: 0.8rem;
      }
      .row-id {
        font-weight: 400;
        color: #9ca3af;
        font-size: 0.75rem;
        margin-left: 0.35rem;
      }
      .row-author {
        font-size: 0.78rem;
        color: #6b7280;
        max-width: 110px;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .row-repo {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 18px;
        height: 18px;
        color: #6b7280;
      }
      .row-repo svg {
        width: 100%;
        height: 100%;
      }
      .row-repo:hover {
        color: #111;
      }
      .lock-icon {
        color: #9ca3af;
        text-align: center;
      }
      .meta {
        font-size: 0.75rem;
        color: #6b7280;
      }
      .meta.err {
        color: #b91c1c;
      }

      /* iOS-style toggle switch. */
      .switch {
        position: relative;
        display: inline-block;
        width: 36px;
        height: 20px;
        flex: none;
      }
      .switch input {
        opacity: 0;
        width: 0;
        height: 0;
      }
      .switch .slider {
        position: absolute;
        inset: 0;
        background-color: #d1d5db;
        border-radius: 999px;
        cursor: pointer;
        transition: background-color 0.15s ease;
      }
      .switch .slider::before {
        content: '';
        position: absolute;
        height: 16px;
        width: 16px;
        left: 2px;
        bottom: 2px;
        background-color: white;
        border-radius: 50%;
        box-shadow: 0 1px 2px rgba(0, 0, 0, 0.3);
        transition: transform 0.15s ease;
      }
      .switch input:checked + .slider {
        background-color: #3b82f6;
      }
      .switch input:checked + .slider::before {
        transform: translateX(16px);
      }
      .switch input:disabled + .slider {
        background-color: #e5e7eb;
        cursor: default;
      }
      .switch.sm {
        width: 30px;
        height: 17px;
      }
      .switch.sm .slider::before {
        height: 13px;
        width: 13px;
      }
      .switch.sm input:checked + .slider::before {
        transform: translateX(13px);
      }

      button.install,
      button.uninstall {
        border: 0;
        padding: 0.3rem 0.7rem;
        border-radius: 0.25rem;
        cursor: pointer;
        font: inherit;
        font-size: 0.85rem;
        display: inline-flex;
        align-items: center;
        gap: 0.25rem;
        white-space: nowrap;
      }
      button.install {
        background: #10b981;
        color: white;
      }
      button.install:hover {
        background: #059669;
      }
      button.install:disabled {
        background: #d1d5db;
        cursor: default;
      }
      button.uninstall {
        background: transparent;
        border: 1px solid #d1d5db;
        color: #6b7280;
      }
      button.uninstall:hover {
        background: #fef2f2;
        border-color: #fecaca;
        color: #b91c1c;
      }

      .add {
        display: flex;
        gap: 0.4rem;
      }
      .add input {
        flex: 1;
        font: inherit;
        padding: 0.4rem 0.5rem;
        border: 1px solid #d1d5db;
        border-radius: 0.25rem;
      }
    `,
  ];

  @state() private urls: string[] = [];
  @state() private records: Map<string, PluginRecord> = new Map();
  @state() private addUrl = '';
  @state() private catalog: CatalogResolved[] = [];
  @state() private catalogError: string | null = null;
  @state() private serverCatalog: CatalogResolved[] = [];
  @state() private serverCatalogError: string | null = null;
  @state() private installing: Set<string> = new Set();
  @state() private catalogUrls: string[] = [defaultCatalogUrl()];
  @state() private activeCatalogUrl: string = defaultCatalogUrl();
  @state() private search = '';
  @state() private filters: Set<Category> = new Set();
  private dialogEl: HTMLDialogElement | null = null;

  override firstUpdated() {
    this.dialogEl = this.shadowRoot?.querySelector('dialog') ?? null;
    const header = this.shadowRoot?.querySelector('.dialog-header') as HTMLElement | null;
    if (this.dialogEl && header) makeDialogDraggable(this.dialogEl, header);
  }

  async open(): Promise<void> {
    const ctx = await getContext();
    const ws = await ctx.store.workspaces.findOne(ctx.workspaceId);
    this.urls = ws?.pluginUrls ?? [];
    const recs = await ctx.store.plugins.find();
    this.records = new Map(recs.map((r) => [r.url, r]));

    const saved = await ctx.store.settings.findOne(CATALOG_URLS_SETTING);
    const savedList = Array.isArray(saved?.value)
      ? (saved.value as unknown[]).filter((v): v is string => typeof v === 'string')
      : [];
    this.catalogUrls = savedList.length > 0 ? savedList : [defaultCatalogUrl()];
    this.activeCatalogUrl = this.catalogUrls[0] ?? defaultCatalogUrl();

    this.addUrl = '';
    this.search = '';
    this.filters = new Set();
    await this.updateComplete;
    this.dialogEl?.showModal();
    // Catalog fetches run after the dialog is visible so a slow network
    // doesn't block opening; rows just appear once the responses land. The
    // server registry is independent of the host catalog — both run in
    // parallel.
    void this.refreshCatalog(this.activeCatalogUrl);
    void this.refreshServerRegistry();
  }

  /**
   * Fetches a plugin catalog from the given URL. Each entry's `url` is
   * resolved against the catalog URL so relative paths (./foo.js) work for
   * sibling plugin files.
   */
  private async refreshCatalog(catalogUrl: string): Promise<void> {
    try {
      const res = await fetch(catalogUrl, { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as { plugins?: CatalogEntry[] };
      const entries = Array.isArray(json.plugins) ? json.plugins : [];
      this.catalog = entries.map((e) => ({
        ...e,
        absUrl: new URL(e.url, catalogUrl).toString(),
      }));
      this.catalogError = null;
    } catch (err) {
      this.catalog = [];
      this.catalogError = (err as Error).message;
    }
  }

  /**
   * Fetches an operator-curated plugin list from the configured server
   * (`${server-sync:url}/plugins/registry`). Silently no-ops when no server
   * URL is set. Network / parse errors surface inline so misconfiguration is
   * visible without breaking the rest of the dialog.
   */
  private async refreshServerRegistry(): Promise<void> {
    const ctx = await getContext();
    const setting = await ctx.store.settings.findOne('server-sync:url');
    const raw = setting?.value;
    if (typeof raw !== 'string' || raw.length === 0) {
      this.serverCatalog = [];
      this.serverCatalogError = null;
      return;
    }
    const base = raw.replace(/\/+$/, '');
    const registryUrl = `${base}/plugins/registry`;
    try {
      const res = await fetch(registryUrl, { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as { plugins?: CatalogEntry[] };
      const entries = Array.isArray(json.plugins) ? json.plugins : [];
      this.serverCatalog = entries.map((e) => ({
        ...e,
        absUrl: new URL(e.url, registryUrl).toString(),
      }));
      this.serverCatalogError = null;
    } catch (err) {
      this.serverCatalog = [];
      this.serverCatalogError = (err as Error).message;
    }
  }

  /** Re-fetches the currently-selected catalog source, remembering it in the dropdown. */
  private async reloadCatalogSource(): Promise<void> {
    const url = this.activeCatalogUrl.trim();
    if (!url) return;
    if (!this.catalogUrls.includes(url)) {
      this.catalogUrls = [...this.catalogUrls, url];
      const ctx = await getContext();
      await ctx.store.settings.upsert({ key: CATALOG_URLS_SETTING, value: this.catalogUrls });
    }
    await this.refreshCatalog(url);
  }

  private close() {
    this.dialogEl?.close();
  }

  private async addPlugin(e: Event) {
    e.preventDefault();
    const url = this.addUrl.trim();
    if (!url) return;
    if (!/^https?:\/\//i.test(url)) {
      const ctx = await getContext();
      await ctx.api.ui.dialogs.alert(
        'Plugin URL must be an absolute http(s) URL.',
        'Invalid URL',
      );
      return;
    }
    if (this.urls.includes(url)) return;
    this.urls = [...this.urls, url];
    const ctx = await getContext();
    await ctx.store.workspaces.patch(ctx.workspaceId, { pluginUrls: this.urls });
    await ctx.store.plugins.upsert({
      url,
      enabled: true,
      lastFetched: 0,
    });
    this.records = new Map(this.records);
    this.addUrl = '';
  }

  private async toggleEnabled(url: string, enabled: boolean) {
    const ctx = await getContext();
    const rec = this.records.get(url);
    await ctx.store.plugins.upsert({
      ...(rec ?? { url, lastFetched: 0 }),
      enabled,
    });
    this.records = new Map(
      this.records.set(url, { ...rec!, url, enabled, lastFetched: rec?.lastFetched ?? 0 }),
    );
  }

  private async removePlugin(url: string) {
    const ctx = await getContext();
    this.urls = this.urls.filter((u) => u !== url);
    await ctx.store.workspaces.patch(ctx.workspaceId, { pluginUrls: this.urls });
    await ctx.store.plugins.remove(url);
    this.records.delete(url);
    this.records = new Map(this.records);
  }

  private reload() {
    location.reload();
  }

  private async toggleBuiltin(id: string, enabled: boolean): Promise<void> {
    const ctx = await getContext();
    const key = builtinKey(id);
    const rec = this.records.get(key);
    await ctx.store.plugins.upsert({
      ...(rec ?? { url: key, lastFetched: 0 }),
      url: key,
      enabled,
      lastFetched: rec?.lastFetched ?? 0,
    });
    this.records = new Map(
      this.records.set(key, { ...rec!, url: key, enabled, lastFetched: rec?.lastFetched ?? 0 }),
    );
  }

  /** Dispatches an enable/disable toggle to the right store slot and hints that a reload is needed. */
  private async onRowToggle(row: PluginRow, enabled: boolean): Promise<void> {
    if (row.categories.has('built-in')) {
      await this.toggleBuiltin(row.id, enabled);
    } else if (row.url) {
      await this.toggleEnabled(row.url, enabled);
    } else {
      return;
    }
    const ctx = await getContext();
    ctx.api.ui.dialogs.toast('Reload to apply this change.', {
      kind: 'info',
      title: 'Plugin updated',
    });
  }

  /**
   * Installs a catalog entry into the current workspace and hot-loads it
   * without a reload. Mirrors url-loader.ts's fetch → blob → import → init →
   * load flow, then re-emits `app:ready` so the shell's registry snapshots
   * pick up any new header/footer buttons immediately.
   */
  private async installFromCatalog(entry: { absUrl: string; name: string }): Promise<void> {
    if (this.urls.includes(entry.absUrl)) return;
    if (this.installing.has(entry.absUrl)) return;
    this.installing = new Set(this.installing).add(entry.absUrl);
    const ctx = await getContext();
    try {
      const res = await fetch(entry.absUrl, { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      const body = await res.text();

      await ctx.store.workspaces.patch(ctx.workspaceId, {
        pluginUrls: [...this.urls, entry.absUrl],
      });
      await ctx.store.plugins.upsert({
        url: entry.absUrl,
        enabled: true,
        lastFetched: Date.now(),
        cachedBody: body,
      });

      const blob = new Blob([body], { type: 'text/javascript' });
      const blobUrl = URL.createObjectURL(blob);
      try {
        const mod = (await import(/* @vite-ignore */ blobUrl)) as PluginModule;
        await mod.init?.(ctx.api);
        await mod.load?.(ctx.api);
      } finally {
        setTimeout(() => URL.revokeObjectURL(blobUrl), 5000);
      }

      // Re-emit so app-shell / panel-footer / data-table re-snapshot their
      // registry slices and the new UI surfaces appear without a reload.
      ctx.events.emit('app:ready', { workspaceId: ctx.workspaceId });

      this.urls = [...this.urls, entry.absUrl];
      const recs = await ctx.store.plugins.find();
      this.records = new Map(recs.map((r) => [r.url, r]));
      ctx.api.ui.dialogs.toast(`Activated "${entry.name}".`, {
        kind: 'success',
        title: 'Plugin installed',
      });
    } catch (err) {
      await ctx.store.plugins.upsert({
        url: entry.absUrl,
        enabled: true,
        lastFetched: Date.now(),
        lastError: `install: ${(err as Error).message}`,
      });
      ctx.api.ui.dialogs.toast(
        `Could not install ${entry.name}: ${(err as Error).message}`,
        { kind: 'error', title: 'Plugin error' },
      );
    } finally {
      const next = new Set(this.installing);
      next.delete(entry.absUrl);
      this.installing = next;
    }
  }

  private toggleFilter(cat: Category, on: boolean): void {
    const next = new Set(this.filters);
    if (on) next.add(cat);
    else next.delete(cat);
    this.filters = next;
  }

  /**
   * Merges built-ins, catalog/server entries, and installed-by-URL plugins
   * into one row per plugin. Catalog entries and installed-by-URL entries
   * that share a URL are merged into a single row (both "available" and
   * "installed" categories); anything installed by URL with no matching
   * catalog metadata gets its own row keyed by the raw URL.
   */
  private buildRows(): PluginRow[] {
    const rows = new Map<string, PluginRow>();
    const urlToKey = new Map<string, string>();

    for (const { id, meta } of builtinPlugins) {
      const enabled = meta.fixed ? true : this.records.get(builtinKey(id))?.enabled !== false;
      const categories: Category[] = meta.fixed ? ['built-in', 'fixed'] : ['built-in'];
      rows.set(`builtin:${id}`, {
        id,
        name: meta.name,
        ...(meta.description ? { meta: meta.description } : { meta: 'Built-in plugin' }),
        ...(meta.author ? { author: meta.author } : {}),
        ...(meta.icon ? { icon: meta.icon } : {}),
        ...(meta.repo ? { repo: meta.repo } : {}),
        categories: new Set(categories),
        enabled,
        fixed: !!meta.fixed,
      });
    }

    for (const entry of [...this.catalog, ...this.serverCatalog]) {
      const installedByUrl = this.urls.includes(entry.absUrl);
      const rec = this.records.get(entry.absUrl);
      const categories: Category[] = installedByUrl ? ['available', 'installed'] : ['available'];
      const existing = rows.get(entry.id);
      rows.set(entry.id, {
        id: entry.id,
        name: entry.name,
        url: entry.absUrl,
        ...(entry.icon ? { icon: entry.icon } : {}),
        ...(entry.repo ? { repo: entry.repo } : {}),
        ...(entry.author ? { author: entry.author } : {}),
        meta: entry.description ?? entry.absUrl,
        categories: existing
          ? new Set([...existing.categories, ...categories])
          : new Set(categories),
        enabled: rec?.enabled !== false,
        installing: this.installing.has(entry.absUrl),
      });
      urlToKey.set(entry.absUrl, entry.id);
    }

    for (const url of this.urls) {
      const existingKey = urlToKey.get(url);
      if (existingKey) {
        rows.get(existingKey)!.categories.add('installed');
        continue;
      }
      const rec = this.records.get(url);
      const lastFetched = rec?.lastFetched
        ? new Date(rec.lastFetched).toLocaleString()
        : 'never';
      rows.set(`url:${url}`, {
        id: url,
        name: url,
        urlOnly: true,
        url,
        meta: rec?.lastError ?? `Last fetched: ${lastFetched}`,
        metaIsError: !!rec?.lastError,
        categories: new Set(['installed']),
        enabled: rec?.enabled !== false,
      });
    }

    return [...rows.values()];
  }

  private get filteredRows(): PluginRow[] {
    const rows = this.buildRows();
    const term = this.search.trim().toLowerCase();
    const byFilter =
      this.filters.size === 0
        ? rows
        : rows.filter((r) => [...r.categories].some((c) => this.filters.has(c)));
    if (!term) return byFilter;
    return byFilter.filter((r) =>
      [r.id, r.name, r.meta, r.author].some((f) => f?.toLowerCase().includes(term)),
    );
  }

  private renderRow(row: PluginRow) {
    const showToggle = row.categories.has('built-in') || row.categories.has('installed');
    const canUninstall = !!row.url && row.categories.has('installed');
    const canInstall = !!row.url && !row.categories.has('installed');
    return html`
      <div class=${`row${row.categories.has('built-in') ? ' builtin' : ''}${row.metaIsError ? ' error' : ''}`}>
        <span class="row-icon">${row.icon ? unsafeHTML(row.icon) : FALLBACK_ICON}</span>
        <div class="row-main">
          <div class=${`row-title${row.urlOnly ? ' mono' : ''}`}>
            ${row.name}${row.id !== row.name
              ? html`<span class="row-id">${row.id}</span>`
              : ''}
          </div>
          ${row.meta
            ? html`<div class=${`meta${row.metaIsError ? ' err' : ''}`}>${row.meta}</div>`
            : ''}
        </div>
        <div class="row-author">${row.author ?? ''}</div>
        ${row.repo
          ? html`<a
              class="row-repo"
              href=${row.repo}
              target="_blank"
              rel="noopener noreferrer"
              title="View source on GitHub"
              >${unsafeHTML(GITHUB_ICON_SVG)}</a
            >`
          : html`<span></span>`}
        ${row.fixed
          ? html`<span class="mi sm lock-icon" title="Always on — cannot be disabled">lock</span>`
          : showToggle
            ? html`<label class="switch" title="Enable / disable">
                <input
                  type="checkbox"
                  .checked=${row.enabled}
                  @change=${(e: Event) =>
                    this.onRowToggle(row, (e.target as HTMLInputElement).checked)}
                />
                <span class="slider"></span>
              </label>`
            : html`<span></span>`}
        ${canInstall
          ? html`<button
              type="button"
              class="install"
              ?disabled=${row.installing}
              @click=${() => this.installFromCatalog({ absUrl: row.url!, name: row.name })}
            >
              <span class="mi sm">${row.installing ? 'hourglass_empty' : 'download'}</span>
              ${row.installing ? 'Installing…' : 'Install'}
            </button>`
          : canUninstall
            ? html`<button
                type="button"
                class="uninstall"
                @click=${() => this.removePlugin(row.url!)}
              >
                <span class="mi sm">delete</span> Uninstall
              </button>`
            : html`<span></span>`}
      </div>
    `;
  }

  override render() {
    const rows = this.filteredRows;
    return html`
      <dialog @cancel=${this.close} @keydown=${ctrlEnterSubmits}>
        <button type="button" class="close-x" title="Close" @click=${this.close}>
          <span class="mi sm">close</span>
        </button>
        <form @submit=${this.addPlugin}>
          <div class="dialog-header">
            <h2>Plugins</h2>
            <div class="header-actions">
              <button type="button" class="ghost" @click=${this.close}>Close</button>
              <button type="button" class="primary" @click=${this.reload}>
                <span class="mi sm">refresh</span> Reload to apply
              </button>
            </div>
          </div>
          <div class="dialog-body">
            <p class="hint">
              Plugins are JavaScript modules loaded by URL into this workspace.
              Enable/disable changes take effect after reload; installing a
              plugin activates it immediately.
            </p>

            <div class="filters">
              ${FILTER_LABELS.map(
                ([cat, label]) => html`
                  <label class="toggle-label">
                    <span class="switch sm">
                      <input
                        type="checkbox"
                        .checked=${this.filters.has(cat)}
                        @change=${(e: Event) =>
                          this.toggleFilter(cat, (e.target as HTMLInputElement).checked)}
                      />
                      <span class="slider"></span>
                    </span>
                    ${label}
                  </label>
                `,
              )}
              <div class="search">
                <input
                  type="text"
                  placeholder="Search plugins…"
                  .value=${this.search}
                  @input=${(e: Event) => (this.search = (e.target as HTMLInputElement).value)}
                />
              </div>
            </div>

            <div class="catalog-source">
              <input
                type="text"
                list="catalog-url-options"
                .value=${this.activeCatalogUrl}
                @input=${(e: Event) => (this.activeCatalogUrl = (e.target as HTMLInputElement).value)}
                placeholder="Catalog source URL"
              />
              <datalist id="catalog-url-options">
                ${this.catalogUrls.map((u) => html`<option value=${u}></option>`)}
              </datalist>
              <button type="button" class="ghost" @click=${this.reloadCatalogSource}>
                <span class="mi sm">refresh</span> Reload
              </button>
            </div>
            ${this.catalogError
              ? html`<div class="meta err">Catalog unavailable: ${this.catalogError}</div>`
              : ''}
            ${this.serverCatalogError
              ? html`<div class="meta err">Server registry unavailable: ${this.serverCatalogError}</div>`
              : ''}

            <div class="plugin-list">
              ${rows.length === 0
                ? html`<p class="hint">No plugins match the current filters/search.</p>`
                : ''}
              ${rows.map((row) => this.renderRow(row))}
            </div>

            <div class="add">
              <input
                type="text"
                placeholder="https://example.com/my-plugin.js"
                .value=${this.addUrl}
                @input=${(e: Event) => (this.addUrl = (e.target as HTMLInputElement).value)}
              />
              <button type="submit" class="primary">
                <span class="mi sm">add</span> Add
              </button>
            </div>
          </div>
        </form>
      </dialog>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'plugin-manager-dialog': PluginManagerDialog;
  }
}
