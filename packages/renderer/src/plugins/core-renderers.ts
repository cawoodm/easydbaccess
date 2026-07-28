import type { ColumnSpec, HostApi, PluginModule } from '@easydb/shared';
import { makePencil, makeValueEditor, pencilRow } from './cell-pencil.js';

export const meta: NonNullable<PluginModule['meta']> = {
  id: 'core-renderers',
  name: 'Core Renderers',
  type: 'cell-renderer',
  version: '0.1.0',
  description: 'Built-in cell renderers: date, datetime, boolean, script.',
  author: 'Marc Cawood',
  icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/></svg>',
  repo: 'https://github.com/cawoodm/easydbaccess/blob/main/packages/renderer/src/plugins/core-renderers.ts',
  fixed: true,
};

/**
 * Defines `<cell-date>`, `<cell-datetime>`, `<cell-boolean>`, and the
 * power-user `<cell-script>` element, and registers each under the
 * matching renderer name. The script renderer reads `column.script` (a
 * user-authored JS body that must define `function render(row)`) and
 * dumps the returned string into the cell as raw HTML — same trust
 * model the plugin host already grants user-supplied code.
 */
export function init(api: HostApi): void {
  if (!customElements.get('cell-date')) customElements.define('cell-date', CellDate);
  if (!customElements.get('cell-datetime')) customElements.define('cell-datetime', CellDatetime);
  if (!customElements.get('cell-boolean')) customElements.define('cell-boolean', CellBoolean);
  if (!customElements.get('cell-script')) customElements.define('cell-script', CellScript);
  api.ui.registerCellRenderer('date', 'cell-date');
  api.ui.registerCellRenderer('datetime', 'cell-datetime');
  api.ui.registerCellRenderer('boolean', 'cell-boolean');
  api.ui.registerCellRenderer('script', 'cell-script');
}

class CellDate extends HTMLElement {
  private _value: unknown = '';
  private _readonly = false;

  set value(v: unknown) {
    if (this._value === v) return;
    this._value = v;
    this.render();
  }
  get value(): unknown {
    return this._value;
  }

  // Set by data-table in a read-only view: display the date, don't edit it.
  set readonly(v: boolean) {
    const n = !!v;
    if (this._readonly === n) return;
    this._readonly = n;
    this.render();
  }
  get readonly(): boolean {
    return this._readonly;
  }

  connectedCallback() {
    this.render();
  }

  private render() {
    this.innerHTML = '';
    if (this._readonly) {
      this.textContent = toDateIso(this._value);
      return;
    }
    const input = document.createElement('input');
    input.type = 'date';
    input.value = toDateIso(this._value);
    input.style.cssText =
      'font:inherit;border:0;background:transparent;padding:0;width:100%;box-sizing:border-box';
    input.addEventListener('change', () => this.commit(input.value || null));
    this.append(input);
  }

  private commit(v: string | null) {
    this._value = v;
    this.dispatchEvent(
      new CustomEvent('change', { detail: { value: v }, bubbles: true, composed: true }),
    );
  }
}

class CellDatetime extends HTMLElement {
  private _value: unknown = '';
  private _readonly = false;

  set value(v: unknown) {
    if (this._value === v) return;
    this._value = v;
    this.render();
  }
  get value(): unknown {
    return this._value;
  }

  set readonly(v: boolean) {
    const n = !!v;
    if (this._readonly === n) return;
    this._readonly = n;
    this.render();
  }
  get readonly(): boolean {
    return this._readonly;
  }

  connectedCallback() {
    this.render();
  }

  private render() {
    this.innerHTML = '';
    if (this._readonly) {
      this.textContent = toDatetimeLocal(this._value).replace('T', ' ');
      return;
    }
    const input = document.createElement('input');
    input.type = 'datetime-local';
    input.value = toDatetimeLocal(this._value);
    input.style.cssText =
      'font:inherit;border:0;background:transparent;padding:0;width:100%;box-sizing:border-box';
    input.addEventListener('change', () => this.commit(input.value || null));
    this.append(input);
  }

  private commit(v: string | null) {
    this._value = v;
    this.dispatchEvent(
      new CustomEvent('change', { detail: { value: v }, bubbles: true, composed: true }),
    );
  }
}

class CellBoolean extends HTMLElement {
  private _value: unknown = false;
  private _readonly = false;

  set value(v: unknown) {
    if (this._value === v) return;
    this._value = v;
    this.render();
  }
  get value(): unknown {
    return this._value;
  }

  set readonly(v: boolean) {
    const n = !!v;
    if (this._readonly === n) return;
    this._readonly = n;
    this.render();
  }
  get readonly(): boolean {
    return this._readonly;
  }

  connectedCallback() {
    this.render();
  }

  private render() {
    this.innerHTML = '';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = coerceBool(this._value);
    if (this._readonly) {
      // Read-only view: show the state but don't allow toggling.
      input.disabled = true;
      input.style.cssText = 'transform:translateY(1px)';
      this.append(input);
      return;
    }
    input.style.cssText = 'transform:translateY(1px);cursor:pointer';
    input.addEventListener('change', () => this.commit(input.checked));
    this.append(input);
  }

  private commit(v: boolean) {
    this._value = v;
    this.dispatchEvent(
      new CustomEvent('change', { detail: { value: v }, bubbles: true, composed: true }),
    );
  }
}

function coerceBool(v: unknown): boolean {
  return v === true || v === 'true' || v === 1 || v === '1';
}

/**
 * Power-user renderer: the user supplies a JS body on the column
 * (`column.script`) that must define `function render(row) { … }`. We
 * compile once per unique source, invoke per cell, and inject the
 * returned string as raw HTML. Throws and non-string returns surface as
 * a small inline error chip so a single broken script doesn't blow up
 * the rest of the row.
 *
 * Trust model: the plugin host already allows user-supplied code to do
 * anything in the page, so column scripts are no worse. The user
 * authored the script by clicking the pencil in the column editor.
 */
class CellScript extends HTMLElement {
  private _column: ColumnSpec | null = null;
  private _row: Record<string, unknown> = {};
  private _value: unknown = '';
  private _readonly = false;
  private _editing = false;
  /** The input allowed to commit — see `makeValueEditor`. */
  private _editor: HTMLInputElement | null = null;

  set column(c: ColumnSpec | null) {
    this._column = c;
    // Never repaint over an open editor. data-table re-binds `.row` with a
    // freshly-read object on EVERY table render, so identity always differs and
    // this setter fires constantly — it would otherwise throw away whatever the
    // user is typing the moment any row in the table changes.
    if (this._editing) return;
    this.render();
  }
  get column(): ColumnSpec | null {
    return this._column;
  }

  set row(r: Record<string, unknown> | null | undefined) {
    this._row = (r ?? {}) as Record<string, unknown>;
    if (this._editing) return;
    this.render();
  }
  get row(): Record<string, unknown> {
    return this._row;
  }

  // The script reads from `.row`, so the rendered OUTPUT ignores this. We still
  // keep it: it's this column's stored value, and the pencil edits it. (It used
  // to be discarded, which is why a script cell had no way back to its value.)
  set value(v: unknown) {
    if (this._value === v) return;
    this._value = v;
    this._editing = false;
    this.render();
  }
  get value(): unknown {
    return this._value;
  }

  // A read-only view offers no pencil.
  set readonly(v: boolean) {
    const n = !!v;
    if (this._readonly === n) return;
    this._readonly = n;
    this.render();
  }
  get readonly(): boolean {
    return this._readonly;
  }

  connectedCallback() {
    this.render();
  }

  private render() {
    this.innerHTML = '';
    this._editor = null;
    this.style.display = 'block';
    this.style.minWidth = '0';
    this.style.overflow = 'hidden';

    if (this._editing) {
      const input = makeValueEditor({
        value: this._value == null ? '' : String(this._value),
        onCommit: (v) => this.commit(v),
        onCancel: () => {
          // Disown the editor before re-rendering: removing it fires a blur
          // that must not save the edit being cancelled.
          this._editor = null;
          this._editing = false;
          this.render();
        },
        isLive: (el) => this._editor === el,
      });
      this.append(input);
      this._editor = input;
      return;
    }

    this.append(this._readonly ? this.renderOutput() : pencilRow(this.renderOutput(), this.pencil()));
  }

  /** The pencil that swaps the rendered output for a raw-value editor. */
  private pencil(): HTMLElement {
    return makePencil(() => {
      this._editing = true;
      this.render();
    }, 'Edit the stored value');
  }

  /** The script's own output, or an inline chip explaining why there is none. */
  private renderOutput(): HTMLElement {
    const src = this._column?.script;
    if (!src || !src.trim()) {
      const placeholder = document.createElement('span');
      placeholder.textContent = '(no script)';
      placeholder.style.cssText = 'color:#9ca3af;font-style:italic';
      return placeholder;
    }
    let fn: (row: unknown) => unknown;
    try {
      fn = compileScript(src);
    } catch (err) {
      return makeErrorChip('compile error', err);
    }
    let out: unknown;
    try {
      out = fn(this._row);
    } catch (err) {
      return makeErrorChip('runtime error', err);
    }
    if (typeof out !== 'string') {
      return makeErrorChip('render(row) did not return a string', null);
    }
    const host = document.createElement('span');
    host.style.cssText = 'display:block;width:100%';
    // Raw HTML injection — exactly what the user asked the renderer for.
    // Inline <script> tags are inert when assigned via innerHTML so this
    // does not bypass the page's existing trust boundaries.
    host.innerHTML = out;
    return host;
  }

  private commit(v: string) {
    const changed = v !== this._value;
    this._value = v;
    this._editing = false;
    this.render();
    if (!changed) return;
    this.dispatchEvent(
      new CustomEvent('change', { detail: { value: v }, bubbles: true, composed: true }),
    );
  }
}

const compiledScripts = new Map<string, (row: unknown) => unknown>();

function compileScript(src: string): (row: unknown) => unknown {
  const cached = compiledScripts.get(src);
  if (cached) return cached;
  // The user's body defines `render`; we then call it with the bound row.
  // Wrapping in a function lets them also have `const` declarations,
  // imports of `Date`/`Math`, etc., scoped to the function.
  const fn = new Function('row', `${src}\nreturn render(row);`) as (row: unknown) => unknown;
  compiledScripts.set(src, fn);
  return fn;
}

function makeErrorChip(label: string, err: unknown): HTMLElement {
  const chip = document.createElement('span');
  chip.textContent = `⚠ ${label}`;
  chip.style.cssText =
    'color:#b91c1c;font-size:0.8em;font-family:ui-monospace,SFMono-Regular,monospace';
  if (err) {
    const msg = err instanceof Error ? err.message : String(err);
    chip.title = msg;
  }
  return chip;
}

/**
 * Coerce arbitrary stored values into the YYYY-MM-DD string that
 * `<input type=date>` expects. Returns '' if it can't parse — leaves the
 * input empty rather than showing a misleading "Invalid Date".
 */
function toDateIso(raw: unknown): string {
  if (typeof raw !== 'string' && typeof raw !== 'number') return '';
  const s = String(raw).trim();
  if (!s) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return '';
  return d.toISOString().slice(0, 10);
}

/**
 * Same idea for `<input type=datetime-local>`, which wants YYYY-MM-DDTHH:MM
 * (no timezone). We strip seconds/timezone bits because the input ignores them.
 */
function toDatetimeLocal(raw: unknown): string {
  if (typeof raw !== 'string' && typeof raw !== 'number') return '';
  const s = String(raw).trim();
  if (!s) return '';
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})/.exec(s);
  if (m) return `${m[1]}T${m[2]}`;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return `${s}T00:00`;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return '';
  const iso = d.toISOString();
  return `${iso.slice(0, 10)}T${iso.slice(11, 16)}`;
}
