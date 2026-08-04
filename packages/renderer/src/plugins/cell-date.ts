import type { HostApi, PluginModule } from '@easydb/shared';
import { markInvalid } from '../util/cell-validity.js';
import { makePencil, makeValueEditor, pencilRow } from './cell-pencil.js';

export const meta: NonNullable<PluginModule['meta']> = {
  id: 'cell-date',
  name: 'Cell Date',
  type: 'cell-renderer',
  version: '0.1.0',
  description:
    'Renderer for date columns: a native `<input type=date>` picker. A ' +
    "non-empty value the picker can't parse shows as red-bordered raw text " +
    'with a pencil instead of a misleadingly blank box. Apply by setting a ' +
    'column\'s renderer to "date".',
  author: 'Marc Cawood',
  icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>',
  repo: 'https://github.com/cawoodm/easydbaccess/blob/main/packages/renderer/src/plugins/cell-date.ts',
};

/** Defines `<cell-date>` and registers it under the renderer name `date`. */
export function init(api: HostApi): void {
  if (!customElements.get('cell-date')) customElements.define('cell-date', CellDate);
  api.ui.registerCellRenderer('date', 'cell-date');
}

class CellDate extends HTMLElement {
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
    // as an empty date box — indistinguishable from "no data". Show it raw
    // and fixable instead of blanking it.
    if (isInvalidDate(this._value)) {
      const text = document.createElement('span');
      text.textContent = String(this._value);
      text.style.cssText = 'display:inline-block;width:100%;overflow:hidden;text-overflow:ellipsis';
      markInvalid(text, `Not a valid date: "${String(this._value)}"`);
      this.append(this._readonly ? text : pencilRow(text, this.pencil()));
      return;
    }

    if (this._readonly) {
      this.textContent = toDateIso(this._value);
      return;
    }
    const input = document.createElement('input');
    input.type = 'date';
    input.value = toDateIso(this._value);
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

/** A value is invalid, not empty, when it has content but `toDateIso` gave up. */
function isInvalidDate(raw: unknown): boolean {
  if (raw == null) return false;
  if (typeof raw === 'string' && raw.trim() === '') return false;
  return toDateIso(raw) === '';
}
