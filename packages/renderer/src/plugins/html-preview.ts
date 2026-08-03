import type { HostApi, PluginModule } from '@easydb/shared';
import { createPanel } from '../window-mgr/panel-shell/panel-shell.js';
import { shellViewport } from '../window-mgr/jspanel-manager.js';
import { looksLikeHtml, htmlToPreviewText } from '../util/html-text.js';
import { isMobileViewport } from '../util/viewport.js';
import { iconButton, openHtmlEditor, PENCIL_SVG, popupContainer, POPOUT_SVG } from './html-cell-editor.js';

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
  // script reads. The editor must edit that, not the output.
  set rawValue(v: unknown) {
    this._source = v == null ? '' : String(v);
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

    // Only the popup icon here. The text itself is the edit affordance, so a
    // pencil next to it would be a second button for the same job in a cell
    // that is already one line high.
    const popout = iconButton(POPOUT_SVG, 'Open the HTML in a window');
    popout.addEventListener('click', (e) => {
      e.stopPropagation();
      this.openWindow();
    });

    wrap.append(view, spacer, popout);
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

  /**
   * Edit the SOURCE in a textarea panel. On a scripted column that is the
   * stored cell (`rawValue`), not the script output shown in the popup —
   * saving the output would overwrite the Markdown or HTML the script reads.
   */
  private openEditor() {
    const scripted = this._source !== undefined;
    openHtmlEditor(`Edit ${this._label}`, scripted ? this._source! : this._value, (next) => {
      if (scripted) {
        this._source = next;
      } else {
        this._value = next;
        this.render();
      }
      this.dispatchEvent(new CustomEvent('change', { detail: { value: next }, bubbles: true, composed: true }));
    });
  }
}
