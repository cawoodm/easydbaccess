import type { HostApi, PluginModule } from '@easydb/shared';

export const meta: NonNullable<PluginModule['meta']> = {
  name: 'core-renderers',
  version: '0.1.0',
  description: 'Built-in cell renderers: date, datetime, boolean.',
  author: 'easyDBAccess built-ins',
};

/**
 * Defines `<cell-date>`, `<cell-datetime>`, and `<cell-boolean>` and
 * registers them under the renderer names `date`, `datetime`, `boolean`.
 * These are the shapes that used to live as hard-coded switch cases in
 * `<data-table>`; lifted out so every renderer goes through the same
 * registry path and `<data-table>` no longer special-cases types.
 */
export function init(api: HostApi): void {
  if (!customElements.get('cell-date')) customElements.define('cell-date', CellDate);
  if (!customElements.get('cell-datetime')) customElements.define('cell-datetime', CellDatetime);
  if (!customElements.get('cell-boolean')) customElements.define('cell-boolean', CellBoolean);
  api.ui.registerCellRenderer('date', 'cell-date');
  api.ui.registerCellRenderer('datetime', 'cell-datetime');
  api.ui.registerCellRenderer('boolean', 'cell-boolean');
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
    input.style.cssText = 'font:inherit;border:0;background:transparent;padding:0;width:100%;box-sizing:border-box';
    input.addEventListener('change', () => this.commit(input.value || null));
    this.append(input);
  }

  private commit(v: string | null) {
    this._value = v;
    this.dispatchEvent(new CustomEvent('change', { detail: { value: v }, bubbles: true, composed: true }));
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
    input.style.cssText = 'font:inherit;border:0;background:transparent;padding:0;width:100%;box-sizing:border-box';
    input.addEventListener('change', () => this.commit(input.value || null));
    this.append(input);
  }

  private commit(v: string | null) {
    this._value = v;
    this.dispatchEvent(new CustomEvent('change', { detail: { value: v }, bubbles: true, composed: true }));
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
    this.dispatchEvent(new CustomEvent('change', { detail: { value: v }, bubbles: true, composed: true }));
  }
}

function coerceBool(v: unknown): boolean {
  return v === true || v === 'true' || v === 1 || v === '1';
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
