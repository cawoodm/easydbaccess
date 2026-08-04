import type { HostApi, PluginModule } from '@easydb/shared';
import { arrayMembers } from '../util/array-cell.js';

export const meta: NonNullable<PluginModule['meta']> = {
  id: 'cell-tags',
  name: 'Cell Tags',
  type: 'cell-renderer',
  version: '0.1.0',
  description:
    'Renderer for `array` columns: each value in the cell shows as its own pill. A comma list ("foo,bar"), a JSON array ("[\\"Foo\\",\\"Bar\\"]") and a real array all read the same. A pencil edits the raw list; an empty list shows nothing.',
  author: 'Marc Cawood',
  icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0l-7.2-7.2a2 2 0 0 1-.6-1.4V4a1 1 0 0 1 1-1h8a2 2 0 0 1 1.4.6l7.2 7.2a2 2 0 0 1 0 2.6z"/><circle cx="7.5" cy="7.5" r="1.2"/></svg>',
  repo: 'https://github.com/cawoodm/easydbaccess/blob/main/packages/renderer/src/plugins/cell-tags.ts',
};

/**
 * Built-in cell renderer for `array` columns — the display half of the type
 * (`util/array-cell.ts` is the reading half). A cell holding several values is
 * one long string in a plain input, and there is no way to see where one value
 * ends and the next starts; a pill per value shows that at a glance.
 *
 * The renderer name is `tags`. It is set automatically on an `array` column at
 * import time (`auto-renderer`, `csv-import`) and can be picked by hand in the
 * columns editor for any column — the pills then read whatever the cell holds,
 * whichever of the three spellings it uses.
 */
export function init(api: HostApi): void {
  if (!customElements.get('cell-tags')) {
    customElements.define('cell-tags', CellTags);
  }
  api.ui.registerCellRenderer('tags', 'cell-tags');
}

/** One pill. Small, quiet, and never wider than the space the column gives. */
const PILL_STYLE =
  'flex:0 1 auto;min-width:0;display:inline-block;max-width:100%;padding:0 0.4rem;' +
  'border:1px solid #d1d5db;border-radius:999px;background:#f3f4f6;color:#374151;' +
  'font-size:0.85em;line-height:1.4;white-space:nowrap;overflow:hidden;text-overflow:ellipsis';

class CellTags extends HTMLElement {
  private _value = '';
  private _editing = false;
  private _readonly = false;
  /**
   * The input allowed to commit. Removing a focused input fires `blur` on it, so
   * identity — not liveness — decides whether an event belongs to the live
   * editor. Escape clears this first, which is what stops a cancelled edit from
   * being saved by its own trailing blur. Same rule as `cell-link`.
   */
  private _editor: HTMLInputElement | null = null;

  set value(v: unknown) {
    // A real array reaches us as an array; `String()` on it gives the comma list
    // the pills are read from anyway, so one string field holds every spelling.
    const s = v == null ? '' : String(v);
    if (this._value === s) return;
    this._value = s;
    this._editing = false;
    this.render();
  }
  get value(): string {
    return this._value;
  }

  set readonly(v: boolean) {
    const next = v === true;
    if (this._readonly === next) return;
    this._readonly = next;
    if (this._readonly) this._editing = false;
    this.render();
  }
  get readonly(): boolean {
    return this._readonly;
  }

  connectedCallback() {
    // Shrinkable block, so the pill row ellipsizes to the current column width
    // instead of widening the column (see `td.has-renderer` in data-table).
    this.style.display = 'block';
    this.style.minWidth = '0';
    this.style.maxWidth = '100%';
    this.style.overflow = 'hidden';
    this.render();
  }

  private render() {
    this.innerHTML = '';
    // Any editor from a previous paint is dead the moment the DOM is wiped.
    this._editor = null;
    if (this._editing && !this._readonly) {
      this.renderEditor();
      return;
    }

    const members = arrayMembers(this._value);
    const wrap = document.createElement('span');
    wrap.style.cssText =
      'display:flex;align-items:center;gap:0.25rem;width:100%;min-width:0;max-width:100%';
    for (const m of members) {
      const pill = document.createElement('span');
      pill.className = 'tag-pill';
      pill.textContent = m;
      pill.title = m;
      pill.style.cssText = PILL_STYLE;
      wrap.append(pill);
    }
    // An empty list stays an empty cell — `[]` is how an absent list arrives from
    // most exports, and a pill holding brackets would read as a value.
    if (!this._readonly) wrap.append(this.pencil());
    this.append(wrap);
  }

  /** The button that swaps the pills for the raw text of the list. */
  private pencil(): HTMLButtonElement {
    const edit = document.createElement('button');
    edit.type = 'button';
    edit.title = 'Edit the list';
    edit.textContent = '✎';
    edit.style.cssText =
      'flex:none;background:transparent;border:0;cursor:pointer;color:#9ca3af;' +
      'font-size:0.85em;padding:0 0.15rem;line-height:1';
    edit.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this._editing = true;
      this.render();
    });
    return edit;
  }

  /**
   * Editing works on the RAW list, not on the pills: a comma list and a JSON
   * array are both legible, and rewriting one into the other on every edit would
   * quietly change data the user did not touch.
   */
  private renderEditor() {
    const input = document.createElement('input');
    input.type = 'text';
    input.value = arrayMembers(this._value).length === 0 ? '' : this._value;
    input.title = 'Comma-separated, or a JSON array';
    input.style.cssText =
      'width:100%;box-sizing:border-box;border:0;background:transparent;font:inherit;padding:0';
    input.addEventListener('change', () => {
      if (this._editor !== input) return;
      this.commit(input.value);
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        this.commit(input.value);
      } else if (e.key === 'Escape') {
        // Disown this input first: render() removes it, which fires blur, and
        // that blur must not save the edit being cancelled.
        this._editor = null;
        this._editing = false;
        this.render();
      }
    });
    // Losing focus leaves edit mode, so the pills come back even when nothing
    // changed — `change` alone would leave the cell an input for good.
    input.addEventListener('blur', () => {
      if (this._editor !== input) return;
      this.commit(input.value);
    });
    this.append(input);
    this._editor = input;
    setTimeout(() => {
      input.focus();
      input.select();
    }, 0);
  }

  private commit(v: string) {
    const changed = v !== this._value;
    this._value = v;
    this._editing = false;
    // Repaint here: the host writes the value back through the `value` setter,
    // which early-returns on an unchanged value — and this just assigned it.
    this.render();
    if (!changed) return;
    this.dispatchEvent(
      new CustomEvent('change', { detail: { value: v }, bubbles: true, composed: true }),
    );
  }
}
