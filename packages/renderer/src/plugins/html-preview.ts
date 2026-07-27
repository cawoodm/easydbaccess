import type { HostApi, PluginModule } from '@easydb/shared';
// @ts-expect-error — jspanel4 ships no types
import { jsPanel } from 'jspanel4/es6module/jspanel.js';

export const meta: NonNullable<PluginModule['meta']> = {
  id: 'html-preview',
  name: 'HTML Preview',
  type: 'cell-renderer',
  version: '0.3.0',
  description:
    'Shows a cell\'s HTML as a plain-text preview (first N characters); click to edit the raw HTML in a dialog, or use the popup icon to view the full rendered HTML in a window. Apply by setting a column\'s renderer to "html-preview". For direct in-cell rendering use the "html" renderer instead.',
  author: 'Marc Cawood',
  icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>',
  repo: 'https://github.com/cawoodm/easydbaccess/blob/main/packages/renderer/src/plugins/html-preview.ts',
};

/** How many characters of the plain text to show inline before truncating.
 *  Configurable via Settings → HTML Preview; read at init and on `app:ready`. */
let maxChars = 30;

async function refreshMaxChars(api: HostApi): Promise<void> {
  const v = await api.settings.get<number>('html-preview', 'maxChars');
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) maxChars = Math.floor(v);
}

export function init(api: HostApi): void {
  if (!customElements.get('html-preview-cell')) {
    customElements.define('html-preview-cell', HtmlPreviewCell);
  }
  api.ui.registerCellRenderer('html-preview', 'html-preview-cell');
  api.ui.registerSettings('html-preview', 'HTML Preview', [
    {
      key: 'maxChars',
      label: 'Max characters shown',
      type: 'number',
      default: 30,
      scope: 'workspace',
      description:
        'HTML-preview cells show the first N characters of the text; use the popup icon on the right to open the full rendered HTML in a window. Applies to cells rendered after the change (reload to refresh all).',
    },
  ]);
  void refreshMaxChars(api);
  api.events.on('app:ready', () => void refreshMaxChars(api));
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

/** Strip tags → collapsed one-line plain text (never rendered as HTML in-cell). */
function htmlToText(html: string): string {
  const tmp = document.createElement('div');
  tmp.innerHTML = html;
  return (tmp.textContent ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * Cell renderer for HTML-valued columns: shows the value's PLAIN TEXT (tags
 * stripped) truncated to `maxChars`, with a small gray popup icon on the right
 * of the column that opens the full RENDERED HTML in a resizable window.
 * Clicking the text opens a dialog to edit the raw HTML. The cell itself never
 * renders arbitrary HTML — only the view popup does.
 */
class HtmlPreviewCell extends HTMLElement {
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
      empty.style.cssText = 'color:#9ca3af;cursor:text';
      empty.textContent = 'empty';
      empty.title = 'Click to edit the HTML';
      empty.addEventListener('click', () => this.openEditor());
      this.append(empty);
      return;
    }
    // Row layout: truncated HTML on the left, a spacer, then the popup icon
    // pinned to the right edge of the column.
    const wrap = document.createElement('span');
    wrap.style.cssText = 'display:flex;align-items:center;gap:0.25rem;width:100%';

    const view = document.createElement('span');
    // Show the HTML's PLAIN TEXT, not the rendered markup — rendering arbitrary
    // HTML in a grid cell is unpredictable and can be huge. Take the first
    // `maxChars` characters and ellipsize the rest. Clicking edits the raw HTML
    // in a dialog; the popup icon (right) views the full rendered HTML.
    const text = htmlToText(this._value);
    view.textContent = text.length > maxChars ? text.slice(0, maxChars) + '…' : text;
    view.title = 'Click to edit the HTML';
    view.style.cssText =
      'flex:0 1 auto;min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;cursor:text';
    view.addEventListener('click', (e) => {
      e.stopPropagation();
      this.openEditor();
    });

    const spacer = document.createElement('span');
    spacer.style.cssText = 'flex:1 1 auto';

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.title = 'Open the HTML in a window';
    btn.setAttribute('aria-label', 'Open the HTML in a window');
    // Small "open in new window" glyph, gray, darkening on hover.
    btn.innerHTML =
      '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 3h7v7"/><path d="M21 3l-9 9"/><path d="M19 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h6"/></svg>';
    btn.style.cssText =
      'flex:none;display:inline-flex;align-items:center;justify-content:center;' +
      'padding:1px;background:none;border:0;color:#9ca3af;cursor:pointer;line-height:0';
    btn.addEventListener('mouseenter', () => (btn.style.color = '#4b5563'));
    btn.addEventListener('mouseleave', () => (btn.style.color = '#9ca3af'));
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.openWindow();
    });

    wrap.append(view, spacer, btn);
    this.append(wrap);
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

  /** Edit the raw HTML source in a dialog with a textarea; Save commits. */
  private openEditor() {
    const content = document.createElement('div');
    content.style.cssText =
      'display:flex;flex-direction:column;gap:0.5rem;height:100%;box-sizing:border-box;padding:0.5rem';
    const ta = document.createElement('textarea');
    ta.value = this._value;
    ta.style.cssText =
      'flex:1 1 auto;width:100%;box-sizing:border-box;resize:none;font-family:monospace;font-size:0.85rem';
    const bar = document.createElement('div');
    bar.style.cssText = 'display:flex;justify-content:flex-end;gap:0.5rem;flex:none';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.textContent = 'Cancel';
    cancel.style.cssText = 'padding:0.3rem 0.8rem;cursor:pointer';
    const save = document.createElement('button');
    save.type = 'button';
    save.textContent = 'Save';
    save.style.cssText =
      'padding:0.3rem 0.8rem;cursor:pointer;background:#7c3aed;color:#fff;border:0;border-radius:0.25rem';
    bar.append(cancel, save);
    content.append(ta, bar);

    const panel = jsPanel.create({
      id: `easydb-html-edit-${++popupSeq}`,
      container: popupContainer(),
      headerTitle: `Edit ${this._label}`,
      theme: '#7c3aed',
      content,
      contentSize: '520 400',
      position: 'center',
      minimizeTo: '#easydb-minimized-dock',
      dragit: { containment: false },
      resizeit: { containment: false },
    }) as { close: () => void };

    cancel.addEventListener('click', () => panel.close());
    save.addEventListener('click', () => {
      this._value = ta.value;
      this.dispatchEvent(
        new CustomEvent('change', { detail: { value: ta.value }, bubbles: true, composed: true }),
      );
      panel.close();
      this.render();
    });
    // Ctrl+Enter saves, Esc cancels — familiar dialog keys.
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        save.click();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        panel.close();
      }
    });
    setTimeout(() => ta.focus(), 0);
  }
}
