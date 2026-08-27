import type { HostApi, PluginModule } from '@easydb/shared';
import { arrayMembers } from '@easydb/shared';
import { appendTag, applyTag, caretOf, suggestTags, type Caret } from './tag-suggest.js';

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
 * (`array-cell.ts` is the reading half). A cell holding several values is
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
  /** The column's existing members, handed over by `data-table` each render. */
  private _options: readonly string[] = [];
  /** The open suggestion list, or null. A native popover, so nothing clips it. */
  private _list: HTMLElement | null = null;
  private _items: string[] = [];
  /** Which suggestion the arrow keys have landed on; -1 is none. */
  private _active = -1;
  /**
   * The caret the open list was built for, or null when it is answering "what
   * else could go in here" rather than "finish this word".
   *
   * Taking a suggestion has to do what the list offered. The list on open is the
   * column's vocabulary minus this cell's tags — an ADD — and applying that as a
   * completion replaced the whole cell (the value is selected when the editor
   * opens), so picking a second tag dropped the first.
   */
  private _caret: Caret | null = null;

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

  /**
   * The values this column already holds, for the autocomplete.
   *
   * Stored, never rendered on: `data-table` sets this on EVERY render, and a
   * repaint here would destroy the input being typed into. The live editor reads
   * it when it needs it.
   */
  set suggestions(v: unknown) {
    this._options = Array.isArray(v) ? v.map((x) => String(x)) : [];
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
    // Any editor from a previous paint is dead the moment the DOM is wiped, and
    // a suggestion list belonging to it has nothing left to type into.
    this._editor = null;
    this.closeList();
    if (this._editing && !this._readonly) {
      this.renderEditor();
      return;
    }

    const members = arrayMembers(this._value);
    const wrap = document.createElement('span');
    wrap.style.cssText = 'display:flex;align-items:center;gap:0.25rem;width:100%;min-width:0;max-width:100%';
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
    edit.style.cssText = 'flex:none;background:transparent;border:0;cursor:pointer;color:#9ca3af;' + 'font-size:0.85em;padding:0 0.15rem;line-height:1';
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
    input.style.cssText = 'width:100%;box-sizing:border-box;border:0;background:transparent;font:inherit;padding:0';
    input.addEventListener('change', () => {
      if (this._editor !== input) return;
      this.commit(input.value);
    });
    input.addEventListener('input', () => this.refreshList(input));
    // Moving the caret changes which word is being typed, so the list has to
    // follow it — `input` alone misses a click or an arrow across a comma.
    input.addEventListener('click', () => this.refreshList(input));
    input.addEventListener('keydown', (e) => {
      const n = this._items.length;
      if (e.key === 'ArrowDown' && n > 0) {
        e.preventDefault();
        this.highlight((this._active + 1) % n);
        return;
      }
      if (e.key === 'ArrowUp' && n > 0) {
        e.preventDefault();
        this.highlight((this._active - 1 + n) % n);
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        // A highlighted suggestion takes the Enter; with none highlighted the
        // cell still saves, so a tag typed by hand never needs the mouse.
        const pick = this._items[this._active];
        if (pick !== undefined) {
          this.takeSuggestion(input, pick);
          return;
        }
        this.commit(input.value);
        return;
      }
      if (e.key === 'Escape') {
        // One Escape closes the list, a second cancels the edit — dismissing a
        // list the user never asked for must not throw away their typing.
        // `stopPropagation` keeps that first Escape from reaching the panel
        // shell, which would close the window behind the cell.
        if (this._list) {
          e.preventDefault();
          e.stopPropagation();
          this.closeList();
          return;
        }
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
      // Opened straight away, so a cell shows what this column calls things
      // rather than waiting for a first letter that has to be guessed.
      //
      // `null` — add mode. `select()` above selected the whole value, and a
      // selection reads as the word being typed (see `tag-suggest.ts`), so asking
      // at the real caret would offer only the tag already in the cell and then
      // replace it. What is useful here is what the cell is MISSING.
      this.refreshList(input, null);
    }, 0);
  }

  /** Rebuild the list for whatever word the caret is in, or close it. */
  private refreshList(input: HTMLInputElement, caret: Caret | null = caretOf(input)) {
    this._caret = caret;
    // In add mode the question is "what is missing from this cell", which is what
    // an empty term at the start of the text asks.
    this._items = suggestTags(this._options, input.value, caret ?? { from: 0, to: 0 });
    this._active = -1;
    if (this._items.length === 0) {
      this.closeList();
      return;
    }
    this.openList(input);
  }

  private openList(input: HTMLInputElement) {
    let list = this._list;
    if (!list) {
      list = document.createElement('div');
      list.className = 'tag-suggest';
      // A popover, like every other transient layer in this app: the browser owns
      // the top layer, so the cell's `overflow:hidden` cannot clip the list and
      // there is no z-index race to lose. `manual`, not `auto`: an auto popover
      // light-dismisses on the next click, and the next click is usually the
      // suggestion itself. See docs/tech/DIALOGS.md.
      list.setAttribute('popover', 'manual');
      list.setAttribute('role', 'listbox');
      list.style.cssText =
        'position:fixed;margin:0;padding:0.15rem;border:1px solid #d1d5db;border-radius:0.25rem;' +
        'background:#fff;color:#374151;box-shadow:0 6px 16px rgba(0,0,0,0.15);font:inherit;' +
        'font-size:0.9em;max-height:14rem;overflow:auto;min-width:8rem';
      document.body.append(list);
      this._list = list;
      (list as HTMLElement & { showPopover?: () => void }).showPopover?.();
    }
    list.innerHTML = '';
    this._items.forEach((value, i) => {
      const item = document.createElement('div');
      item.className = 'tag-suggest-item';
      item.setAttribute('role', 'option');
      item.setAttribute('aria-selected', i === this._active ? 'true' : 'false');
      item.textContent = value;
      item.style.cssText = 'padding:0.2rem 0.5rem;border-radius:0.2rem;cursor:pointer;white-space:nowrap;' + (i === this._active ? 'background:#eff6ff;color:#1d4ed8' : '');
      // `mousedown`, not `click`: a click blurs the input first, and that blur
      // commits and repaints the cell — taking this element with it before the
      // click could land. The default is prevented so the caret stays put.
      item.addEventListener('mousedown', (e) => {
        e.preventDefault();
        this.takeSuggestion(input, value);
      });
      list.append(item);
    });
    const r = input.getBoundingClientRect();
    list.style.left = Math.round(r.left) + 'px';
    list.style.top = Math.round(r.bottom + 2) + 'px';
  }

  private highlight(i: number) {
    this._active = i;
    if (this._editor) this.openList(this._editor);
  }

  /** Put a suggestion into the text and offer the next one. */
  private takeSuggestion(input: HTMLInputElement, pick: string) {
    const applied = this._caret ? applyTag(input.value, caretOf(input), pick) : appendTag(input.value, pick);
    input.value = applied.text;
    input.setSelectionRange(applied.caret, applied.caret);
    this.refreshList(input);
  }

  private closeList() {
    const list = this._list;
    this._list = null;
    this._items = [];
    this._active = -1;
    this._caret = null;
    if (!list) return;
    (list as HTMLElement & { hidePopover?: () => void }).hidePopover?.();
    list.remove();
  }

  disconnectedCallback() {
    this.closeList();
  }

  private commit(raw: string) {
    const changed = raw !== this._value;
    // A taken suggestion leaves `red, blue, ` — the trailing separator invites the
    // next tag and is meaningless once the edit is over (`arrayMembers` drops
    // empty members either way). Tidied only on a value that was actually
    // edited: cleaning up an untouched cell would turn opening its editor and
    // clicking away into a write, and every write marks the workspace unsaved.
    const v = changed ? raw.replace(/[,\s]+$/, '') : raw;
    this._value = v;
    this._editing = false;
    // Repaint here: the host writes the value back through the `value` setter,
    // which early-returns on an unchanged value — and this just assigned it.
    this.render();
    if (!changed) return;
    this.dispatchEvent(new CustomEvent('change', { detail: { value: v }, bubbles: true, composed: true }));
  }
}
