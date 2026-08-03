import type { HostApi, PluginModule } from '@easydb/shared';
import { iconButton, openHtmlEditor, PENCIL_SVG } from './html-cell-editor.js';

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
    'Renders a cell\'s value directly as HTML (unescaped, in full, no popup); a pencil on the right edits the source. Apply by setting a column\'s renderer to "html". For a truncated preview use "html-preview".',
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
 * Cell renderer that renders the value's HTML directly in the cell, in full.
 * A small pencil on the right of the column opens the source in a textarea.
 *
 * The rendered markup itself is NOT a click target. It used to be — a click
 * anywhere in the cell swapped the HTML for a text input — which meant a link
 * inside the value could not be followed, and a value the size of a feed body
 * had to be edited in a one-line input. The pencil separates the two.
 */
class HtmlRenderCell extends HTMLElement {
  private _value = '';
  /** The STORED cell, set by data-table only on a scripted column. */
  private _source: string | undefined;
  private _label = 'HTML';

  set value(v: string) {
    const next = v ?? '';
    if (this._value === next) return;
    this._value = next;
    this.render();
  }
  get value() {
    return this._value;
  }

  // On a scripted column `value` is the script's OUTPUT; `rawValue` is what the
  // script reads. The pencil must edit that, not the output.
  set rawValue(v: unknown) {
    this._source = v == null ? '' : String(v);
  }

  set column(c: { label?: string } | undefined) {
    this._label = c?.label ?? 'HTML';
  }

  connectedCallback() {
    this.render();
  }

  private render() {
    this.innerHTML = '';
    const wrap = document.createElement('span');
    wrap.style.cssText = 'display:flex;align-items:flex-start;gap:0.25rem;width:100%';

    const view = document.createElement('span');
    view.style.cssText = 'flex:1 1 auto;min-width:0';
    if (this._value) {
      view.innerHTML = this._value;
    } else {
      view.style.color = '#9ca3af';
      view.textContent = 'empty';
    }

    const pencil = iconButton(PENCIL_SVG, 'Edit the HTML');
    pencil.addEventListener('click', (e) => {
      e.stopPropagation();
      this.openEditor();
    });

    wrap.append(view, pencil);
    this.append(wrap);
  }

  private openEditor() {
    const scripted = this._source !== undefined;
    openHtmlEditor(`Edit ${this._label}`, scripted ? this._source! : this._value, (next) => {
      if (scripted) {
        // The script re-runs on the new source and pushes a fresh `value` back
        // in, so there is nothing to render here.
        this._source = next;
      } else {
        this._value = next;
        this.render();
      }
      this.dispatchEvent(new CustomEvent('change', { detail: { value: next }, bubbles: true, composed: true }));
    });
  }
}
