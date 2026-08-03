import type { HostApi, PluginModule } from '@easydb/shared';
import { createPanel } from '../window-mgr/panel-shell/panel-shell.js';
import { shellViewport } from '../window-mgr/jspanel-manager.js';
import { looksLikeHtml, htmlToPreviewText } from '../util/html-text.js';
import { isMobileViewport } from '../util/viewport.js';

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
    const text = htmlToPreviewText(this._value);
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
    if (looksLikeHtml(this._value)) {
      content.innerHTML = this._value;
    } else {
      // Plain text: render inside a <pre> using textContent — this preserves
      // newlines/indentation and safely escapes any `<`/`&` in the value,
      // instead of letting innerHTML collapse whitespace and parse them as
      // markup.
      const pre = document.createElement('pre');
      pre.style.cssText =
        'white-space:pre-wrap;word-break:break-word;margin:0;font-family:ui-monospace, monospace;';
      pre.textContent = this._value;
      content.append(pre);
    }
    createPanel({
      id: `easydb-html-popup-${++popupSeq}`,
      container: popupContainer(),
      title: this._label,
      color: '#7c3aed',
      content,
      // 520×400 is wider than a phone, so on mobile the popup opened partly
      // off-screen and had to be panned to be read. Rendered HTML is the one
      // thing you open this window to LOOK at, so on a narrow viewport it
      // starts maximized and fills the canvas. The 520×400 rect is still what
      // Restore returns to, so nothing is lost — it is the opening state that
      // changes, not the window.
      contentSize: { w: 520, h: 400 },
      position: { centerTopOffset: 60 },
      boot: { maximized: isMobileViewport() },
      minimizeTo: '#easydb-minimized-dock',
      viewport: shellViewport(),
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

    const panel = createPanel({
      id: `easydb-html-edit-${++popupSeq}`,
      container: popupContainer(),
      title: `Edit ${this._label}`,
      color: '#7c3aed',
      content,
      contentSize: { w: 520, h: 400 },
      position: 'center',
      // Same reasoning as the view popup above — and more pressing here,
      // because a textarea you cannot see the edge of is hard to type into,
      // and the Save/Cancel buttons sit at its bottom-right, the corner a
      // too-wide panel pushes off-screen first.
      boot: { maximized: isMobileViewport() },
      minimizeTo: '#easydb-minimized-dock',
      viewport: shellViewport(),
    });

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
