import { LitElement, css, html, nothing } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import type { RegisteredSettings, SettingScope, SettingsFieldSpec } from '@easydb/shared';
import { getContext } from '../app-context.js';
import { materialIconStyles } from '../chrome/material-icon-css.js';
import { ctrlEnterSubmits, dialogChromeStyles } from './dialog-chrome.js';
import { makeDialogDraggable } from './draggable.js';
import { watchDialogDirty } from '../chrome/dirty-guard.js';
import { parseSecrets, readSecretsText, readUserSetting, writeSecretsText } from '../db/user-settings.js';
import { emitSettingsChanged } from '../db/settings-events.js';

const GENERAL = '__general__';

interface Tab {
  id: string;
  name: string;
  fields: SettingsFieldSpec[];
}

/**
 * Tabbed Settings dialog. The General tab holds the cross-workspace secrets
 * editor; every plugin that called `api.ui.registerSettings` gets its own tab.
 * Each field row carries a `user` checkbox that promotes/demotes the value
 * between the synced workspace layer and the device-local user layer. Edits
 * save immediately (no Save button) via `api.settings.set`.
 */
@customElement('settings-dialog')
export class SettingsDialog extends LitElement {
  static override styles = [
    materialIconStyles,
    dialogChromeStyles,
    css`
      dialog {
        width: 720px;
        max-width: 94vw;
      }
      .layout {
        display: grid;
        grid-template-columns: 180px 1fr;
        gap: 1rem;
        min-height: 340px;
      }
      .tabs {
        display: flex;
        flex-direction: column;
        gap: 0.15rem;
        border-right: 1px solid #e5e7eb;
        padding-right: 0.5rem;
      }
      .tabs button {
        text-align: left;
        background: transparent;
        border: 0;
        border-radius: 0.3rem;
        padding: 0.45rem 0.6rem;
        cursor: pointer;
        font: inherit;
        color: #374151;
      }
      .tabs button:hover {
        background: #f3f4f6;
      }
      .tabs button.active {
        background: #eff6ff;
        color: #1d4ed8;
        font-weight: 600;
      }
      .panel {
        display: flex;
        flex-direction: column;
        gap: 1rem;
        min-width: 0;
      }
      .field {
        display: flex;
        flex-direction: column;
        gap: 0.25rem;
      }
      .field-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 0.5rem;
      }
      .field-head label {
        font-weight: 600;
        font-size: 0.9rem;
      }
      .scope {
        display: inline-flex;
        align-items: center;
        gap: 0.25rem;
        font-size: 0.75rem;
        color: #6b7280;
        cursor: pointer;
        user-select: none;
      }
      .desc {
        font-size: 0.78rem;
        color: #6b7280;
        margin: 0;
      }
      /* (i) next to the label — opens the field's help panel. */
      .help-btn {
        background: transparent;
        border: 0;
        padding: 0;
        margin-right: auto;
        color: #6b7280;
        cursor: pointer;
        display: inline-flex;
        align-items: center;
        line-height: 1;
      }
      .help-btn:hover,
      .help-btn[aria-expanded='true'] {
        color: #1d4ed8;
      }
      .help-panel {
        font-size: 0.8rem;
        color: #374151;
        background: #eff6ff;
        border: 1px solid #bfdbfe;
        border-radius: 0.3rem;
        padding: 0.45rem 0.6rem;
        display: flex;
        flex-direction: column;
        gap: 0.3rem;
      }
      .help-panel p {
        margin: 0;
      }
      .help-panel a {
        color: #1d4ed8;
        align-self: flex-start;
      }
      input[type='text'],
      input[type='number'],
      input[type='date'],
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
        min-height: 4.5rem;
        resize: vertical;
        font-family: ui-monospace, SFMono-Regular, monospace;
        font-size: 0.85rem;
      }
      .secrets-actions {
        display: flex;
        justify-content: flex-end;
        margin-top: 0.4rem;
      }
      button.ghost {
        display: inline-flex;
        align-items: center;
        gap: 0.3rem;
        font: inherit;
        font-size: 0.85rem;
        background: #f3f4f6;
        border: 1px solid #d1d5db;
        border-radius: 0.25rem;
        padding: 0.3rem 0.6rem;
        color: #374151;
        cursor: pointer;
      }
      button.ghost:hover:not(:disabled) {
        background: #e5e7eb;
      }
      button.ghost:disabled {
        opacity: 0.5;
        cursor: default;
      }
      .secret-row {
        display: flex;
        gap: 0.4rem;
        align-items: center;
      }
      .secret-row select {
        width: auto;
        flex: 0 0 auto;
      }
      .secret-row input.invalid {
        border-color: #dc2626;
        background: #fef2f2;
      }
      .secret-error {
        margin: 0.5rem 1rem 0;
        padding: 0.5rem 0.7rem;
        background: #fef2f2;
        border: 1px solid #fecaca;
        border-radius: 0.35rem;
        color: #b91c1c;
        font-size: 0.82rem;
      }
      .radios,
      .checks {
        display: flex;
        flex-wrap: wrap;
        gap: 0.5rem 1rem;
      }
      .radios label,
      .checks label {
        display: inline-flex;
        align-items: center;
        gap: 0.3rem;
        font-size: 0.9rem;
        font-weight: 400;
      }
      .radios input,
      .checks input {
        width: auto;
      }
      .empty {
        color: #6b7280;
        font-size: 0.9rem;
      }
      .blurb {
        color: #4b5563;
        font-size: 0.9rem;
        margin: 0;
      }
      h3 {
        margin: 0;
        font-size: 1rem;
      }
    `,
  ];

  @state() private tabs: Tab[] = [];
  @state() private active = GENERAL;
  /** Raw (un-interpolated) values keyed `${pluginId}:${key}`. */
  @state() private values: Record<string, unknown> = {};
  /** Current layer per key, keyed `${pluginId}:${key}`. */
  @state() private placements: Record<string, SettingScope> = {};
  @state() private secretsText = '';
  @state() private workspaceTitle = '';
  /** Set when a close was blocked because a secret field held a raw value. */
  @state() private secretError = '';
  /**
   * Which field's (i) help panel is open, as `${tabId}:${key}` — one at a time,
   * so a tab of fields with help does not turn into a wall of text.
   */
  @state() private openHelp = '';
  private dialogEl: HTMLDialogElement | null = null;

  override firstUpdated() {
    this.dialogEl = this.shadowRoot?.querySelector('dialog') ?? null;
    const header = this.shadowRoot?.querySelector('.dialog-header') as HTMLElement | null;
    if (this.dialogEl && header) makeDialogDraggable(this.dialogEl, header);
    // A typed-in token or URL must survive a reload — see dirty-guard.
    if (this.dialogEl) watchDialogDirty('settings', this.dialogEl);
  }

  async open(): Promise<void> {
    const ctx = await getContext();
    const registered: Array<[string, RegisteredSettings]> = [...ctx.registries.settings];
    this.tabs = registered.map(([id, r]) => ({ id, name: r.name, fields: r.fields }));

    const ws = await ctx.store.workspaces.findOne(ctx.workspaceId);
    this.workspaceTitle = ws?.title ?? '';

    const values: Record<string, unknown> = {};
    const placements: Record<string, SettingScope> = {};
    for (const tab of this.tabs) {
      for (const f of tab.fields) {
        const k = `${tab.id}:${f.key}`;
        const placement = await ctx.api.settings.placement(tab.id, f.key);
        if (placement === 'user') {
          values[k] = readUserSetting(k);
          placements[k] = 'user';
        } else if (placement === 'workspace') {
          values[k] = (await ctx.store.settings.findOne(k))?.value;
          placements[k] = 'workspace';
        } else {
          values[k] = f.default;
          placements[k] = f.scope ?? 'workspace';
        }
      }
    }
    this.values = values;
    this.placements = placements;
    this.secretsText = readSecretsText();
    this.active = GENERAL;

    await this.updateComplete;
    this.dialogEl?.showModal();
  }

  /** A secret value that is neither empty nor a `${secret:name}` reference —
   *  i.e. a raw secret that would otherwise be stored/synced in plain text. */
  private static rawSecret(v: unknown): v is string {
    return typeof v === 'string' && v !== '' && !v.includes('${secret:');
  }

  /** Secret-typed fields currently holding a raw value, across every tab. */
  private invalidSecrets(): Array<{ tab: Tab; field: SettingsFieldSpec }> {
    const bad: Array<{ tab: Tab; field: SettingsFieldSpec }> = [];
    for (const tab of this.tabs) {
      for (const f of tab.fields) {
        if (f.type !== 'secret') continue;
        if (SettingsDialog.rawSecret(this.values[`${tab.id}:${f.key}`])) bad.push({ tab, field: f });
      }
    }
    return bad;
  }

  /** Every `${secret:name}` name in a value. Any field may hold a reference,
   *  not only a secret-typed one, so callers scan all of them. */
  private static secretRefs(v: unknown): string[] {
    if (typeof v !== 'string') return [];
    return [...v.matchAll(/\$\{secret:([^}]*)\}/g)].map((m) => (m[1] ?? '').trim());
  }

  /** Names a value references that the secrets store does not define. */
  private missingRefs(v: unknown): string[] {
    const known = new Set(Object.keys(parseSecrets(this.secretsText)));
    return SettingsDialog.secretRefs(v).filter((name) => !known.has(name));
  }

  /**
   * Fields referencing a secret name that is not in the store. `interpolateSecrets`
   * leaves an unknown name in place verbatim, so the plugin goes on to use the
   * literal `${secret:name}` text as its token — a failure that surfaces much
   * later, as a rejected request. The dialog is the place to catch it.
   */
  private danglingSecrets(): Array<{ tab: Tab; field: SettingsFieldSpec; names: string[] }> {
    const bad: Array<{ tab: Tab; field: SettingsFieldSpec; names: string[] }> = [];
    for (const tab of this.tabs) {
      for (const f of tab.fields) {
        const names = this.missingRefs(this.values[`${tab.id}:${f.key}`]);
        if (names.length > 0) bad.push({ tab, field: f, names });
      }
    }
    return bad;
  }

  /**
   * Close unless a secret field holds a raw value, or a field points at a secret
   * name the store does not define — then block and point at the first offender.
   */
  private attemptClose = (e?: Event): void => {
    const bad = this.invalidSecrets();
    if (bad.length > 0) {
      // On the native `cancel` (Esc) event, preventDefault keeps the dialog open.
      e?.preventDefault();
      const first = bad[0]!;
      this.active = first.tab.id;
      this.secretError =
        `“${first.field.label}” must be empty or a \${secret:name} reference. ` +
        `Move the value into the secrets store (General tab) and reference it, ` +
        `so the raw secret is never saved or synced.`;
      return;
    }
    const dangling = this.danglingSecrets();
    if (dangling.length > 0) {
      e?.preventDefault();
      const first = dangling[0]!;
      this.active = first.tab.id;
      const names = first.names.map((n) => `“${n}”`).join(', ');
      this.secretError =
        `“${first.field.label}” references ${names}, which the secrets store does not have. ` +
        `Add it in the General tab or correct the name — an unknown reference is passed on as ` +
        `the literal \${secret:name} text.`;
      return;
    }
    this.secretError = '';
    this.dialogEl?.close();
  };

  // Fields already auto-save on change; Done/Ctrl+Enter just closes — unless a
  // secret field still holds a raw value (see attemptClose).
  private onSubmit = (e: Event): void => {
    e.preventDefault();
    this.attemptClose();
  };

  private async setValue(tab: Tab, f: SettingsFieldSpec, value: unknown) {
    const k = `${tab.id}:${f.key}`;
    this.values = { ...this.values, [k]: value };
    this.clearSecretErrorIfFixed();
    const ctx = await getContext();
    await ctx.api.settings.set(tab.id, f.key, value, this.placements[k]);
    // Announced after the write, so a listener that re-reads sees the new value.
    // This dialog auto-saves per field, so this is where "a setting changed"
    // actually happens — there is no Save button to hang it off.
    emitSettingsChanged(tab.id, f.key);
  }

  private async toggleScope(tab: Tab, f: SettingsFieldSpec, user: boolean) {
    const k = `${tab.id}:${f.key}`;
    const scope: SettingScope = user ? 'user' : 'workspace';
    this.placements = { ...this.placements, [k]: scope };
    const ctx = await getContext();
    // Re-write the current value into the chosen layer; the resolver removes
    // the other layer so the key lives in exactly one place.
    await ctx.api.settings.set(tab.id, f.key, this.values[k], scope);
  }

  /** Drop a blocked-close message once the offending value is gone. Adding the
   *  missing secret counts as a fix too, hence the call from onSecretsInput. */
  private clearSecretErrorIfFixed(): void {
    if (!this.secretError) return;
    if (this.invalidSecrets().length === 0 && this.danglingSecrets().length === 0) {
      this.secretError = '';
    }
  }

  private onSecretsInput(e: Event) {
    this.secretsText = (e.target as HTMLTextAreaElement).value;
    writeSecretsText(this.secretsText);
    this.clearSecretErrorIfFixed();
  }

  /** Save the current secrets store to a `secrets.txt` file the user can back
   * up or carry to another device (drag it back in to re-import). */
  private downloadSecrets() {
    const blob = new Blob([this.secretsText], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'secrets.txt';
    a.click();
    URL.revokeObjectURL(url);
  }

  private async setWorkspaceTitle(value: string) {
    this.workspaceTitle = value;
    const ctx = await getContext();
    await ctx.store.workspaces.patch(ctx.workspaceId, { title: value.trim() || undefined });
  }

  private renderControl(tab: Tab, f: SettingsFieldSpec) {
    const k = `${tab.id}:${f.key}`;
    const v = this.values[k];
    switch (f.type) {
      case 'text':
        return html`<textarea .value=${String(v ?? '')} @change=${(e: Event) => this.setValue(tab, f, (e.target as HTMLTextAreaElement).value)}></textarea>`;
      case 'number':
        return html`<input
          type="number"
          .value=${v == null ? '' : String(v)}
          @change=${(e: Event) => {
            const raw = (e.target as HTMLInputElement).value;
            this.setValue(tab, f, raw === '' ? undefined : Number(raw));
          }}
        />`;
      case 'boolean':
        return html`<label class="scope"><input type="checkbox" .checked=${Boolean(v)} @change=${(e: Event) => this.setValue(tab, f, (e.target as HTMLInputElement).checked)} /> enabled</label>`;
      case 'date':
        return html`<input type="date" .value=${String(v ?? '')} @change=${(e: Event) => this.setValue(tab, f, (e.target as HTMLInputElement).value)} />`;
      case 'secret':
        return this.renderSecretControl(tab, f, v);
      case 'option':
        return html`<div class="radios">
          ${(f.options ?? []).map((opt) => html`<label><input type="radio" name=${k} .checked=${v === opt} @change=${() => this.setValue(tab, f, opt)} />${opt}</label>`)}
        </div>`;
      case 'selection': {
        const arr = Array.isArray(v) ? (v as string[]) : [];
        return html`<div class="checks">
          ${(f.options ?? []).map(
            (opt) =>
              html`<label
                ><input
                  type="checkbox"
                  .checked=${arr.includes(opt)}
                  @change=${(e: Event) => {
                    const on = (e.target as HTMLInputElement).checked;
                    const next = on ? [...arr, opt] : arr.filter((x) => x !== opt);
                    this.setValue(tab, f, next);
                  }}
                />${opt}</label
              >`,
          )}
        </div>`;
      }
      case 'string':
      default:
        return html`<input type="text" .value=${String(v ?? '')} @change=${(e: Event) => this.setValue(tab, f, (e.target as HTMLInputElement).value)} />`;
    }
  }

  private renderSecretControl(tab: Tab, f: SettingsFieldSpec, v: unknown) {
    const names = Object.keys(parseSecrets(this.secretsText));
    // Red border for a raw secret AND for a reference to a name that is not in
    // the store — both block the close, so both must be visible as the cause.
    const invalid = SettingsDialog.rawSecret(v) || this.missingRefs(v).length > 0;
    return html`<div class="secret-row">
      <input
        type="text"
        class=${invalid ? 'invalid' : ''}
        placeholder="value or \${secret:name}"
        .value=${String(v ?? '')}
        @change=${(e: Event) => this.setValue(tab, f, (e.target as HTMLInputElement).value)}
      />
      ${names.length > 0
        ? html`<select
            title="Insert a secret reference"
            @change=${(e: Event) => {
              const name = (e.target as HTMLSelectElement).value;
              if (name) this.setValue(tab, f, `\${secret:${name}}`);
              (e.target as HTMLSelectElement).value = '';
            }}
          >
            <option value="">🔑 secret…</option>
            ${names.map((n) => html`<option value=${n}>${n}</option>`)}
          </select>`
        : nothing}
    </div>`;
  }

  private renderField(tab: Tab, f: SettingsFieldSpec) {
    const k = `${tab.id}:${f.key}`;
    const hasHelp = Boolean(f.help || f.helpUrl);
    const helpOpen = this.openHelp === k;
    return html`<div class="field">
      <div class="field-head">
        <label>${f.label}</label>
        ${hasHelp
          ? html`<button
              type="button"
              class="help-btn"
              aria-label=${`Help for ${f.label}`}
              aria-expanded=${helpOpen ? 'true' : 'false'}
              title=${f.help ?? 'More about this setting'}
              @click=${() => (this.openHelp = helpOpen ? '' : k)}
            >
              <span class="mi sm" aria-hidden="true">info</span>
            </button>`
          : nothing}
        <label class="scope" title="Store on this device only (not synced)">
          <input type="checkbox" .checked=${this.placements[k] === 'user'} @change=${(e: Event) => this.toggleScope(tab, f, (e.target as HTMLInputElement).checked)} />
          user
        </label>
      </div>
      ${hasHelp && helpOpen
        ? html`<div class="help-panel">
            ${f.help ? html`<p>${f.help}</p>` : nothing} ${f.helpUrl ? html`<a href=${f.helpUrl} target="_blank" rel="noopener noreferrer">${f.helpLinkLabel || hostOf(f.helpUrl)}</a>` : nothing}
          </div>`
        : nothing}
      ${this.renderControl(tab, f)} ${f.description ? html`<p class="desc">${f.description}</p>` : nothing}
    </div>`;
  }

  private renderGeneral() {
    return html`
      <h3>General</h3>
      <p class="blurb">
        Workspace settings sync with this workspace; values marked
        <em>user</em> stay on this device only.
      </p>
      <div class="field">
        <div class="field-head"><label>Workspace title</label></div>
        <p class="desc">Shown in the header instead of "easyDBAccess". Leave blank to use the default.</p>
        <input type="text" placeholder="easyDBAccess" .value=${this.workspaceTitle} @change=${(e: Event) => this.setWorkspaceTitle((e.target as HTMLInputElement).value)} />
      </div>
      <div class="field">
        <div class="field-head"><label>Secrets</label></div>
        <p class="desc">
          Cross-workspace, device-local. One <code>name: value</code> per line. Reference a secret from any field with <code>\${secret:name}</code>. Drag a <code>secrets.txt</code> onto the app to
          re-import.
        </p>
        <textarea placeholder="githubPAT: ghp_…" .value=${this.secretsText} @input=${this.onSecretsInput}></textarea>
        <div class="secrets-actions">
          <button type="button" class="ghost" ?disabled=${this.secretsText.trim().length === 0} @click=${this.downloadSecrets}><span class="mi sm">download</span> Download secrets.txt</button>
        </div>
      </div>
    `;
  }

  private renderPanel() {
    if (this.active === GENERAL) return this.renderGeneral();
    const tab = this.tabs.find((t) => t.id === this.active);
    if (!tab) return nothing;
    return html`
      <h3>${tab.name}</h3>
      ${tab.fields.length === 0 ? html`<p class="empty">This plugin registered no settings.</p>` : tab.fields.map((f) => this.renderField(tab, f))}
    `;
  }

  override render() {
    return html`
      <dialog @cancel=${this.attemptClose} @keydown=${ctrlEnterSubmits}>
        <button type="button" class="close-x" title="Close" @click=${() => this.attemptClose()}>
          <span class="mi sm">close</span>
        </button>
        <form @submit=${this.onSubmit}>
          <div class="dialog-header">
            <h2>Settings</h2>
            <div class="header-actions">
              <button type="submit" class="primary">Done</button>
            </div>
          </div>
          ${this.secretError ? html`<div class="secret-error" role="alert">${this.secretError}</div>` : nothing}
          <div class="dialog-body">
            <div class="layout">
              <nav class="tabs">
                <button type="button" class=${this.active === GENERAL ? 'active' : ''} @click=${() => (this.active = GENERAL)}>General</button>
                ${this.tabs.map((t) => html`<button type="button" class=${this.active === t.id ? 'active' : ''} @click=${() => (this.active = t.id)}>${t.name}</button>`)}
              </nav>
              <section class="panel">${this.renderPanel()}</section>
            </div>
          </div>
        </form>
      </dialog>
    `;
  }
}

/**
 * Default link text for a `helpUrl`: its host, so the user can see where the
 * link goes before clicking. Falls back to the raw string for anything that does
 * not parse as a URL.
 */
function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'settings-dialog': SettingsDialog;
  }
}
