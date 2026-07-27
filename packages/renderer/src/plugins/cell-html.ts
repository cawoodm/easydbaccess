import type { HostApi, PluginModule } from '@easydb/shared';
// @ts-expect-error — jspanel4 ships no types
import { jsPanel } from 'jspanel4/es6module/jspanel.js';

export const meta: NonNullable<PluginModule['meta']> = {
  id: 'cell-html',
  name: 'Cell HTML',
  type: 'cell-renderer',
  version: '0.1.0',
  description:
    'Renders a cell\'s raw HTML value inline (unescaped); click the cell to pop the HTML open in its own window. Apply by setting a column\'s renderer to "html".',
  author: 'Marc Cawood',
  icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>',
  repo: 'https://github.com/cawoodm/easydbaccess/blob/main/packages/renderer/src/plugins/cell-html.ts',
};

export function init(api: HostApi): void {
  if (!customElements.get('cell-html')) {
    customElements.define('cell-html', CellHtml);
  }
  api.ui.registerCellRenderer('html', 'cell-html');
}

/** The pan/zoom-transformed canvas viewport popups mount into. */
function popupContainer(): HTMLElement {
  return (
    document.getElementById('easydb-panels-viewport') ??
    document.getElementById('easydb-panels') ??
    document.body
  );
}

let popupSeq = 0;

/**
 * Cell renderer for HTML-valued columns: shows the value rendered (not escaped)
 * inline, clipped to a single line, and opens the full HTML in a resizable
 * window on click. Read-only — the value is display-only, like `cell-link`.
 */
class CellHtml extends HTMLElement {
  private _value = '';
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

  // data-table binds `.column`; use its label for the popup window title.
  set column(c: { label?: string } | undefined) {
    this._label = c?.label ?? 'HTML';
  }

  connectedCallback() {
    this.render();
  }

  private render() {
    this.innerHTML = '';
    if (!this._value) {
      const empty = document.createElement('span');
      empty.style.color = '#9ca3af';
      empty.textContent = 'empty';
      this.append(empty);
      return;
    }
    const view = document.createElement('span');
    // Render the HTML unescaped, clipped to one line so tall/wide markup
    // doesn't blow up the row height.
    view.innerHTML = this._value;
    view.title = 'Click to open in a window';
    view.style.cssText =
      'display:inline-block;max-width:40ch;overflow:hidden;white-space:nowrap;' +
      'text-overflow:ellipsis;vertical-align:middle;cursor:pointer';
    view.addEventListener('click', (e) => {
      e.stopPropagation();
      this.openWindow();
    });
    this.append(view);
  }

  private openWindow() {
    const content = document.createElement('div');
    content.style.cssText = 'padding:0.75rem;overflow:auto;height:100%;box-sizing:border-box';
    content.innerHTML = this._value;
    jsPanel.create({
      id: `easydb-html-popup-${++popupSeq}`,
      container: popupContainer(),
      headerTitle: this._label,
      theme: '#7c3aed',
      content,
      contentSize: '520 400',
      position: 'center-top 0 60',
      minimizeTo: '#easydb-minimized-dock',
      dragit: { containment: false },
      resizeit: { containment: false },
    });
  }
}
