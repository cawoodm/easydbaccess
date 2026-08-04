import type { HostApi, PluginModule } from '@easydb/shared';
import { markInvalid } from '../util/cell-validity.js';
import { makePencil, makeValueEditor, pencilRow } from './cell-pencil.js';

export const meta: NonNullable<PluginModule['meta']> = {
  id: 'cell-datetime',
  name: 'Cell Datetime',
  type: 'cell-renderer',
  version: '0.1.0',
  description:
    'Renderer for datetime columns: a native `<input type=datetime-local>` ' +
    "picker. A non-empty value the picker can't parse shows as red-bordered " +
    'raw text with a pencil instead of a misleadingly blank box. Apply by ' +
    'setting a column\'s renderer to "datetime".',
  author: 'Marc Cawood',
  icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>',
  repo: 'https://github.com/cawoodm/easydbaccess/blob/main/packages/renderer/src/plugins/cell-datetime.ts',
};

/** Defines `<cell-datetime>` and registers it under the renderer name `datetime`. */
export function init(api: HostApi): void {
  if (!customElements.get('cell-datetime')) customElements.define('cell-datetime', CellDatetime);
  api.ui.registerCellRenderer('datetime', 'cell-datetime');
}

class CellDatetime extends HTMLElement {
  private _value: unknown = '';
  private _readonly = false;
  private _editing = false;
  /** The input allowed to commit — see `makeValueEditor`. */
  private _editor: HTMLInputElement | null = null;

  set value(v: unknown) {
    if (this._value === v) return;
    this._value = v;
    this._editing = false;
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
    this._editor = null;

    if (this._editing) {
      const input = makeValueEditor({
        value: this._value == null ? '' : String(this._value),
        onCommit: (v) => this.commit(v || null),
        onCancel: () => {
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

    // A non-empty value the parser can't make sense of would otherwise render
    // as an empty datetime box — indistinguishable from "no data". Show it
    // raw and fixable instead of blanking it.
    if (isInvalidDatetime(this._value)) {
      const text = document.createElement('span');
      text.textContent = String(this._value);
      text.style.cssText = 'display:inline-block;width:100%;overflow:hidden;text-overflow:ellipsis';
      markInvalid(text, `Not a valid datetime: "${String(this._value)}"`);
      this.append(this._readonly ? text : pencilRow(text, this.pencil()));
      return;
    }

    if (this._readonly) {
      this.textContent = toDatetimeLocal(this._value).replace('T', ' ');
      return;
    }
    const input = document.createElement('input');
    input.type = 'datetime-local';
    input.value = toDatetimeLocal(this._value);
    input.style.cssText = 'font:inherit;border:0;background:transparent;padding:0;width:100%;box-sizing:border-box';
    input.addEventListener('change', () => this.commit(input.value || null));
    this.append(input);
  }

  /** The pencil that swaps the invalid raw value for an editor. */
  private pencil(): HTMLElement {
    return makePencil(() => {
      this._editing = true;
      this.render();
    }, 'Edit the stored value');
  }

  private commit(v: string | null) {
    this._value = v;
    this._editing = false;
    this.render();
    this.dispatchEvent(new CustomEvent('change', { detail: { value: v }, bubbles: true, composed: true }));
  }
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

/** A value is invalid, not empty, when it has content but `toDatetimeLocal` gave up. */
function isInvalidDatetime(raw: unknown): boolean {
  if (raw == null) return false;
  if (typeof raw === 'string' && raw.trim() === '') return false;
  return toDatetimeLocal(raw) === '';
}
