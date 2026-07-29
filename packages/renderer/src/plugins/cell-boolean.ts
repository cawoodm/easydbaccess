import type { HostApi, PluginModule } from '@easydb/shared';
import { booleanState, markInvalid } from '../util/cell-validity.js';
import { makePencil, makeValueEditor, pencilRow } from './cell-pencil.js';

export const meta: NonNullable<PluginModule['meta']> = {
  id: 'cell-boolean',
  name: 'Cell Boolean',
  type: 'cell-renderer',
  version: '0.1.0',
  description:
    'Renderer for boolean columns: a checkbox for true/false, a grayed-out ' +
    'unchecked box for an empty cell (clickable to set true), and red-bordered ' +
    'raw text with a pencil for a stored value that is none of those. Apply by ' +
    'setting a column\'s renderer to "boolean".',
  author: 'Marc Cawood',
  icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><polyline points="8 12 11 15 16 9"/></svg>',
  repo: 'https://github.com/cawoodm/easydbaccess/blob/main/packages/renderer/src/plugins/cell-boolean.ts',
};

/** Defines `<cell-boolean>` and registers it under the renderer name `boolean`. */
export function init(api: HostApi): void {
  if (!customElements.get('cell-boolean')) customElements.define('cell-boolean', CellBoolean);
  api.ui.registerCellRenderer('boolean', 'cell-boolean');
}

/**
 * A stored value is one of four states (see `booleanState`): a real `true`,
 * a real `false`, empty (no value stored yet), or invalid (neither — e.g.
 * `'foo'`). The first two render as the checkbox always shown here; empty
 * renders as the same checkbox grayed out so it reads as "no value" rather
 * than "false"; invalid never renders a checkbox at all — a checkbox can't
 * represent a value it isn't — instead the raw value shows as red-bordered
 * text with a pencil (`cell-pencil.ts`) so it stays fixable, mirroring
 * `cell-script.ts`'s editing lifecycle for the same "renderer hides the raw
 * value" problem.
 */
class CellBoolean extends HTMLElement {
  private _value: unknown = false;
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

    const state = booleanState(this._value);
    if (state === 'invalid') {
      const text = document.createElement('span');
      text.textContent = String(this._value);
      text.style.cssText = 'display:inline-block;width:100%;overflow:hidden;text-overflow:ellipsis';
      markInvalid(text, `Not a valid boolean: "${String(this._value)}"`);
      // Read-only view offers no way to fix it — same as every other pencil.
      this.append(this._readonly ? text : pencilRow(text, this.pencil()));
      return;
    }

    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = state === 'true';
    let style = 'transform:translateY(1px)';
    if (state === 'empty') {
      // Grayed out so an empty cell reads as "no value" rather than "false".
      style += ';opacity:0.45';
      input.title = 'Empty — no value stored. Click to set true.';
    }
    if (this._readonly) {
      input.disabled = true;
    } else {
      style += ';cursor:pointer';
      input.addEventListener('change', () => this.commit(input.checked));
    }
    input.style.cssText = style;
    this.append(input);
  }

  /** The pencil that swaps the invalid raw value for an editor. */
  private pencil(): HTMLElement {
    return makePencil(() => {
      this._editing = true;
      this.render();
    }, 'Edit the stored value');
  }

  private commit(v: boolean | string) {
    this._value = v;
    this._editing = false;
    this.render();
    this.dispatchEvent(
      new CustomEvent('change', { detail: { value: v }, bubbles: true, composed: true }),
    );
  }
}
