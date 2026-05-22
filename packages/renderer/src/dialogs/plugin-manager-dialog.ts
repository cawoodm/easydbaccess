import { LitElement, css, html } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import type { PluginRecord } from '@easydb/shared';
import { getContext } from '../app-context.js';
import { materialIconStyles } from '../chrome/material-icon-css.js';
import { makeDialogDraggable } from './draggable.js';

/**
 * Lists plugins installed for the current workspace and lets the user add,
 * enable/disable, or remove them by URL. Plugin URLs live on
 * Workspace.pluginUrls so they sync across devices; per-URL state (cached
 * body, enabled flag, last error) lives on the `plugins` RxDB collection.
 *
 * Changes apply on the next reload — see Apply button copy. Hot-loading
 * a plugin would require unregistering its slot registrations and
 * re-instantiating, which the registry contract doesn't yet support.
 */
@customElement('plugin-manager-dialog')
export class PluginManagerDialog extends LitElement {
  static override styles = [
    materialIconStyles,
    css`
      :host {
        display: contents;
      }
      dialog {
        border: 0;
        border-radius: 0.5rem;
        padding: 0;
        width: 640px;
        max-width: 92vw;
        max-height: 90vh;
        box-shadow: 0 20px 50px rgba(0, 0, 0, 0.25);
        font-family: system-ui, sans-serif;
      }
      dialog::backdrop {
        background: rgba(15, 23, 42, 0.4);
      }
      form {
        padding: 1.1rem 1.25rem;
        display: flex;
        flex-direction: column;
        gap: 0.75rem;
      }
      h2 {
        margin: 0;
        font-size: 1.05rem;
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
      .actions {
        display: flex;
        justify-content: space-between;
        gap: 0.5rem;
        border-top: 1px solid #e5e7eb;
        padding: 0.7rem 1.25rem;
        background: #f9fafb;
      }
      button.primary {
        background: #3b82f6;
        color: white;
        border: 0;
        padding: 0.45rem 0.9rem;
        border-radius: 0.25rem;
        cursor: pointer;
        font: inherit;
      }
      button.primary:hover {
        background: #2563eb;
      }
      button.ghost {
        background: transparent;
        border: 1px solid #d1d5db;
        padding: 0.45rem 0.9rem;
        border-radius: 0.25rem;
        cursor: pointer;
        font: inherit;
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
  private dialogEl: HTMLDialogElement | null = null;

  override firstUpdated() {
    this.dialogEl = this.shadowRoot?.querySelector('dialog') ?? null;
    const h2 = this.shadowRoot?.querySelector('h2') as HTMLElement | null;
    if (this.dialogEl && h2) makeDialogDraggable(this.dialogEl, h2);
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
    this.builtinNames = [
      'new-table-button',
      'csv-import',
      'json-import',
      'csv-export',
      'dump-export',
      'gist-sync',
    ];
    this.addUrl = '';
    await this.updateComplete;
    this.dialogEl?.showModal();
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

  override render() {
    return html`
      <dialog @cancel=${this.close}>
        <form @submit=${this.addPlugin}>
          <h2>Plugins</h2>
          <p class="hint">
            Plugins are JavaScript modules loaded by URL into this workspace.
            Changes take effect after reload.
          </p>

          <div class="plugin-list">
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

          <div class="actions">
            <button type="button" class="ghost" @click=${this.close}>Close</button>
            <button type="button" class="primary" @click=${this.reload}>
              <span class="mi sm">refresh</span> Reload to apply
            </button>
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
