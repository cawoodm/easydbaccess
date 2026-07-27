import type { HostApi, PluginModule } from '@easydb/shared';

// The "html" cell renderer: renders a cell's value directly as HTML, in full,
// with no truncation and no popup. This is the simple, unguarded option — the
// markup is trusted to be well-behaved. For a safe, bounded plain-text preview
// (with a popup for the full HTML) use the separate `html-preview` plugin.

export const meta: NonNullable<PluginModule['meta']> = {
  id: 'html-render',
  name: 'HTML',
  type: 'cell-renderer',
  version: '0.1.0',
  description:
    'Renders a cell\'s value directly as HTML (unescaped, in full, no popup). Apply by setting a column\'s renderer to "html". For a truncated preview use "html-preview".',
  author: 'Marc Cawood',
  icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>',
  repo: 'https://github.com/cawoodm/easydbaccess/blob/main/packages/renderer/src/plugins/html-render.ts',
};

export function init(api: HostApi): void {
  if (!customElements.get('html-render-cell')) {
    customElements.define('html-render-cell', HtmlRenderCell);
  }
  api.ui.registerCellRenderer('html', 'html-render-cell');
}

/**
 * Cell renderer that renders the value's raw HTML directly in the cell, in
 * full. Editable inline like any other cell: click to swap the rendered HTML
 * for a text input over the raw source; Enter/blur commits, Esc cancels. The
 * counterpart to `html-preview` (which edits in a dialog).
 */
class HtmlRenderCell extends HTMLElement {
  private _value = '';
  private editing = false;

  set value(v: string) {
    const next = v ?? '';
    if (this._value === next) return;
    this._value = next;
    if (!this.editing) this.render();
  }
  get value() {
    return this._value;
  }

  connectedCallback() {
    if (!this.editing) this.render();
  }

  private render() {
    this.innerHTML = '';
    const view = document.createElement('span');
    view.style.cssText = 'display:inline-block;min-width:1ch;cursor:text';
    view.title = 'Click to edit';
    if (this._value) {
      view.innerHTML = this._value;
    } else {
      view.style.color = '#9ca3af';
      view.textContent = 'empty';
    }
    view.addEventListener('click', () => this.beginEdit());
    this.append(view);
  }

  private beginEdit() {
    this.editing = true;
    this.innerHTML = '';
    const input = document.createElement('input');
    input.type = 'text';
    input.value = this._value;
    input.style.cssText = 'width:100%;box-sizing:border-box';
    let done = false;
    const commit = () => {
      if (done) return;
      done = true;
      this.editing = false;
      this._value = input.value;
      this.dispatchEvent(
        new CustomEvent('change', { detail: { value: input.value }, bubbles: true, composed: true }),
      );
      this.render();
    };
    input.addEventListener('blur', commit);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        input.blur();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        done = true; // cancel: discard, no commit
        this.editing = false;
        this.render();
      }
    });
    this.append(input);
    input.focus();
    input.select();
  }
}
