import type { ColumnSpec, HostApi, PluginModule } from '@easydb/shared';

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

  set value(v: unknown) {
    if (this._value === v) return;
    this._value = v;
    this.render();
  }
  get value(): unknown {
    return this._value;
  }

  connectedCallback() {
    this.render();
  }

  private render() {
    this.innerHTML = '';
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

  set value(v: unknown) {
    if (this._value === v) return;
    this._value = v;
    this.render();
  }
  get value(): unknown {
    return this._value;
  }

  connectedCallback() {
    this.render();
  }

  private render() {
    this.innerHTML = '';
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

  set value(v: unknown) {
    if (this._value === v) return;
    this._value = v;
    this.render();
  }
  get value(): unknown {
    return this._value;
  }

  connectedCallback() {
    this.render();
  }

  private render() {
    this.innerHTML = '';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = coerceBool(this._value);
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

  set column(c: ColumnSpec | null) {
    this._column = c;
    this.render();
  }
  get column(): ColumnSpec | null {
    return this._column;
  }

  set row(r: Record<string, unknown> | null | undefined) {
    this._row = (r ?? {}) as Record<string, unknown>;
    this.render();
  }
  get row(): Record<string, unknown> {
    return this._row;
  }

  // `value` is bound by data-table for every renderer; we ignore it
  // (the script reads from .row instead), but the setter has to exist
  // so Lit's property binding doesn't fall back to setting an attribute.
  set value(_v: unknown) {
    /* intentionally unused */
  }
  get value(): unknown {
    return undefined;
  }

  connectedCallback() {
    this.render();
  }

  private render() {
    this.innerHTML = '';
    const src = this._column?.script;
    if (!src || !src.trim()) {
      const placeholder = document.createElement('span');
      placeholder.textContent = '(no script)';
      placeholder.style.cssText = 'color:#9ca3af;font-style:italic';
      this.append(placeholder);
      return;
    }
    let fn: (row: unknown) => unknown;
    try {
      fn = compileScript(src);
    } catch (err) {
      this.append(makeErrorChip('compile error', err));
      return;
    }
    let out: unknown;
    try {
      out = fn(this._row);
    } catch (err) {
      this.append(makeErrorChip('runtime error', err));
      return;
    }
    if (typeof out !== 'string') {
      this.append(makeErrorChip('render(row) did not return a string', null));
      return;
    }
    const host = document.createElement('span');
    host.style.cssText = 'display:inline-block;width:100%';
    // Raw HTML injection — exactly what the user asked the renderer for.
    // Inline <script> tags are inert when assigned via innerHTML so this
    // does not bypass the page's existing trust boundaries.
    host.innerHTML = out;
    this.append(host);
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
