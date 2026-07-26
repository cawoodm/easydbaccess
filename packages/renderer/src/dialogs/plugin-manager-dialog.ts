import { LitElement, css, html } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import type { PluginModule, PluginRecord } from '@easydb/shared';
import { getContext } from '../app-context.js';
import { materialIconStyles } from '../chrome/material-icon-css.js';
import { ctrlEnterSubmits, dialogChromeStyles } from './dialog-chrome.js';
import { makeDialogDraggable } from './draggable.js';
import { builtinKey, builtinPlugins } from '../plugin-host/loader.js';

interface OptionalBuiltin {
  name: string;
  description?: string;
  author?: string;
  /** From the synthetic `builtin:<name>` plugin record. Defaults to true. */
  enabled: boolean;
}

interface CatalogEntry {
  id: string;
  name: string;
  description?: string;
  author?: string;
  /** Resolved against the catalog URL — may be relative (./foo.js) or absolute. */
  url: string;
}

interface CatalogResolved extends CatalogEntry {
  /** url resolved to an absolute URL — this is what goes into pluginUrls. */
  absUrl: string;
}

/**
 * Lists plugins installed for the current workspace and lets the user add,
 * enable/disable, or remove them by URL. Plugin URLs live on
 * Workspace.pluginUrls so they sync across devices; per-URL state (cached
 * body, enabled flag, last error) lives on the `plugins` Dexie table.
 *
 * Changes apply on the next reload — see Apply button copy. Hot-loading
 * a plugin would require unregistering its slot registrations and
 * re-instantiating, which the registry contract doesn't yet support.
 */
@customElement('plugin-manager-dialog')
export class PluginManagerDialog extends LitElement {
  static override styles = [
    materialIconStyles,
    dialogChromeStyles,
    css`
      dialog {
        width: 640px;
        max-width: 92vw;
      }
      p.hint {
        margin: 0;
        color: #6b7280;
        font-size: 0.85rem;
      }
      .plugin-list {
        display: flex;
        flex-direction: column;
        gap: 0.4rem;
        max-height: 50vh;
        overflow: auto;
      }
      .row {
        display: grid;
        grid-template-columns: auto 1fr auto;
        gap: 0.5rem;
        align-items: center;
        padding: 0.5rem 0.6rem;
        border: 1px solid #e5e7eb;
        border-radius: 0.3rem;
        background: #f9fafb;
      }
      .row.builtin {
        background: #f3f4f6;
        color: #6b7280;
      }
      .row.error {
        background: #fef2f2;
        border-color: #fecaca;
      }
      .row.available {
        background: #eff6ff;
        border-color: #bfdbfe;
      }
      .section-h {
        margin: 0.4rem 0 0.1rem;
        font-size: 0.78rem;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        color: #6b7280;
      }
      button.install {
        background: #10b981;
        color: white;
        border: 0;
        padding: 0.3rem 0.7rem;
        border-radius: 0.25rem;
        cursor: pointer;
        font: inherit;
        font-size: 0.85rem;
        display: inline-flex;
        align-items: center;
        gap: 0.25rem;
      }
      button.install:hover {
        background: #059669;
      }
      button.install:disabled {
        background: #d1d5db;
        cursor: default;
      }
      .url {
        font-family: ui-monospace, SFMono-Regular, monospace;
        font-size: 0.8rem;
        word-break: break-all;
      }
      .meta {
        font-size: 0.75rem;
        color: #6b7280;
      }
      .meta.err {
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
      button.icon-only {
        background: transparent;
        border: 0;
        cursor: pointer;
        color: #6b7280;
        padding: 0 0.2rem;
      }
      button.icon-only:hover {
        color: #111;
      }
    `,
  ];

  @state() private urls: string[] = [];
  @state() private records: Map<string, PluginRecord> = new Map();
  @state() private addUrl = '';
  @state() private builtinNames: string[] = [];
  @state() private optionalBuiltins: OptionalBuiltin[] = [];
  @state() private dirtyBuiltins = false;
  @state() private catalog: CatalogResolved[] = [];
  @state() private catalogError: string | null = null;
  @state() private serverCatalog: CatalogResolved[] = [];
  @state() private serverCatalogError: string | null = null;
  @state() private installing: Set<string> = new Set();
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
    // Built-in plugin names from the loader's module exports. We can't reach
    // the loader's list here without coupling, so use a hardcoded preview —
    // the dialog purely informs the user; built-ins always load.
    // Built-ins split into always-on and optional. Optional ones are listed
    // separately with an enable toggle; always-on are informational only.
    const alwaysOn: string[] = [];
    const optional: OptionalBuiltin[] = [];
    for (const p of builtinPlugins) {
      const name = p.meta?.name;
      if (!name) continue;
      if (p.meta?.optional) {
        const rec = this.records.get(builtinKey(name));
        optional.push({
          name,
          ...(p.meta?.description ? { description: p.meta.description } : {}),
          ...(p.meta?.author ? { author: p.meta.author } : {}),
          enabled: rec?.enabled !== false,
        });
      } else {
        alwaysOn.push(name);
      }
    }
    this.builtinNames = alwaysOn;
    this.optionalBuiltins = optional;
    this.dirtyBuiltins = false;
    this.addUrl = '';
    await this.updateComplete;
    this.dialogEl?.showModal();
    // Catalog fetches run after the dialog is visible so a slow network
    // doesn't block opening; the sections just appear once the responses
    // land. The server registry is independent of the host catalog — both
    // run in parallel.
    void this.refreshCatalog();
    void this.refreshServerRegistry();
  }

  /**
   * Fetches the plugin catalog from the host this app was loaded from.
   * The catalog is a JSON file listing demo/optional plugins the host ships;
   * it proves the host can act as a registry without hard-coding URLs into
   * the client. Each entry's `url` is resolved against the catalog URL so
   * relative paths (./foo.js) work for sibling plugin files.
   */
  private async refreshCatalog(): Promise<void> {
    // Resolve against the app's deploy base, not the origin root: on GitHub
    // Pages the app is served under /easydbaccess/, so an origin-root
    // /plugins/catalog.json 404s. BASE_URL is '/' in dev and '/easydbaccess/'
    // in the published build, and always ends with a slash.
    const catalogUrl = new URL(
      `${import.meta.env.BASE_URL}plugins/catalog.json`,
      location.origin,
    ).toString();
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
   * URL is set — the "From server" section just doesn't appear. Network /
   * parse errors surface inline so misconfiguration is visible without
   * breaking the rest of the dialog.
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
    this.records = new Map(this.records.set(url, { ...rec!, url, enabled, lastFetched: rec?.lastFetched ?? 0 }));
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

  private async toggleBuiltin(name: string, enabled: boolean): Promise<void> {
    const ctx = await getContext();
    const key = builtinKey(name);
    const rec = this.records.get(key);
    await ctx.store.plugins.upsert({
      ...(rec ?? { url: key, lastFetched: 0 }),
      url: key,
      enabled,
      lastFetched: rec?.lastFetched ?? 0,
    });
    this.optionalBuiltins = this.optionalBuiltins.map((b) =>
      b.name === name ? { ...b, enabled } : b,
    );
    this.dirtyBuiltins = true;
  }

  /**
   * Installs a catalog entry into the current workspace and hot-loads it
   * without a reload. Mirrors url-loader.ts's fetch → blob → import → init →
   * load flow, then re-emits `app:ready` so the shell's registry snapshots
   * pick up any new header/footer buttons immediately.
   */
  private async installFromCatalog(entry: CatalogResolved): Promise<void> {
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

  override render() {
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
            Changes take effect after reload.
          </p>

          <div class="plugin-list">
            ${this.catalog.length > 0
              ? html`<div class="section-h">Available from this host</div>`
              : ''}
            ${this.catalog.map((entry) => {
              const installed = this.urls.includes(entry.absUrl);
              const busy = this.installing.has(entry.absUrl);
              return html`
                <div class="row available">
                  <span class="mi sm">extension</span>
                  <div>
                    <div>${entry.name}</div>
                    <div class="meta">
                      ${entry.description ?? entry.absUrl}
                    </div>
                  </div>
                  <button
                    type="button"
                    class="install"
                    ?disabled=${installed || busy}
                    @click=${() => this.installFromCatalog(entry)}
                  >
                    <span class="mi sm">
                      ${installed ? 'check' : busy ? 'hourglass_empty' : 'download'}
                    </span>
                    ${installed ? 'Installed' : busy ? 'Installing…' : 'Install'}
                  </button>
                </div>
              `;
            })}
            ${this.catalogError
              ? html`<div class="meta err">
                  Host catalog unavailable: ${this.catalogError}
                </div>`
              : ''}

            ${this.serverCatalog.length > 0 || this.serverCatalogError
              ? html`<div class="section-h">From server</div>`
              : ''}
            ${this.serverCatalog.map((entry) => {
              const installed = this.urls.includes(entry.absUrl);
              const busy = this.installing.has(entry.absUrl);
              return html`
                <div class="row available">
                  <span class="mi sm">extension</span>
                  <div>
                    <div>${entry.name}</div>
                    <div class="meta">
                      ${entry.description ?? entry.absUrl}
                    </div>
                  </div>
                  <button
                    type="button"
                    class="install"
                    ?disabled=${installed || busy}
                    @click=${() => this.installFromCatalog(entry)}
                  >
                    <span class="mi sm">
                      ${installed ? 'check' : busy ? 'hourglass_empty' : 'download'}
                    </span>
                    ${installed ? 'Installed' : busy ? 'Installing…' : 'Install'}
                  </button>
                </div>
              `;
            })}
            ${this.serverCatalogError
              ? html`<div class="meta err">
                  Server registry unavailable: ${this.serverCatalogError}
                </div>`
              : ''}

            ${this.optionalBuiltins.length > 0
              ? html`<div class="section-h">Optional built-ins</div>`
              : ''}
            ${this.optionalBuiltins.map(
              (b) => html`
                <div class="row">
                  <input
                    type="checkbox"
                    title="Enable / disable"
                    .checked=${b.enabled}
                    @change=${(e: Event) =>
                      this.toggleBuiltin(b.name, (e.target as HTMLInputElement).checked)}
                  />
                  <div>
                    <div>${b.name}</div>
                    <div class="meta">
                      ${b.description ?? 'Built-in (optional)'}
                    </div>
                  </div>
                  <span class="meta">${b.enabled ? 'enabled' : 'disabled'}</span>
                </div>
              `,
            )}

            <div class="section-h">Built-in</div>
            ${this.builtinNames.map(
              (name) => html`
                <div class="row builtin">
                  <span class="mi sm">extension</span>
                  <div>
                    <div>${name}</div>
                    <div class="meta">Built-in</div>
                  </div>
                  <span class="meta">always on</span>
                </div>
              `,
            )}

            ${this.urls.length > 0
              ? html`<div class="section-h">Installed (by URL)</div>`
              : ''}
            ${this.urls.map((url) => {
              const rec = this.records.get(url);
              const errClass = rec?.lastError ? ' error' : '';
              const lastFetched = rec?.lastFetched
                ? new Date(rec.lastFetched).toLocaleString()
                : 'never';
              return html`
                <div class=${`row${errClass}`}>
                  <input
                    type="checkbox"
                    title="Enable / disable"
                    .checked=${rec?.enabled !== false}
                    @change=${(e: Event) =>
                      this.toggleEnabled(url, (e.target as HTMLInputElement).checked)}
                  />
                  <div>
                    <div class="url">${url}</div>
                    <div class=${`meta${rec?.lastError ? ' err' : ''}`}>
                      ${rec?.lastError ?? `Last fetched: ${lastFetched}`}
                    </div>
                  </div>
                  <button
                    type="button"
                    class="icon-only"
                    title="Remove plugin"
                    @click=${() => this.removePlugin(url)}
                  >
                    <span class="mi sm">delete</span>
                  </button>
                </div>
              `;
            })}
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
