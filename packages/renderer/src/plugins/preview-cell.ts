// packages/renderer/src/plugins/preview-cell.ts
//
// The cell shared by the two renderers that show a long value as ONE LINE of
// plain text with the formatted value behind a popup: `preview` (which guesses
// the language) and `markdown` (which always converts as Markdown).
//
// Neither renders markup in the cell itself. A grid row is one line high, and
// arbitrary HTML in a cell is unpredictable and can be huge — headings, lists and
// images would each set their own row height. So the cell holds text and the
// popup holds the render. That is the whole difference from `html-render.ts`,
// which puts the markup straight in the cell.

import { createPanel } from '../window-mgr/panel-shell/panel-shell.js';
import { shellViewport } from '../window-mgr/shell-viewport.js';
import { htmlToPreviewText } from '../util/html-text.js';
import { isMobileViewport } from '../util/viewport.js';
import { iconButton, openHtmlEditor, popupContainer, POPOUT_SVG } from './html-cell-editor.js';

/** The safety cap on cell text — long enough that the column width, not this
 *  number, is what cuts the line on any realistic column. */
export const DEFAULT_MAX_CHARS = 2000;

/**
 * How much text goes INTO the cell. Not how much is visible: the cell clips with
 * CSS (`text-overflow: ellipsis`), so what you see follows the COLUMN WIDTH,
 * exactly as it does for a cell with no renderer. Widen the column and more of
 * the value appears; narrow it and less does.
 *
 * The number is only a safety cap, which is why the default is generous. It used
 * to be 30, and a 30-character cut is what "auto ellipsis stops working when a
 * renderer is involved" meant: the renderer replaced the column-width ellipsis
 * with a fixed count, so a wide column still showed 30 characters. A workspace
 * that deliberately set a small number keeps it — a stored value still wins.
 *
 * One number for both renderers: it caps the DOM, not the meaning of a column,
 * and Settings → Preview is where it is set.
 */
let maxChars = DEFAULT_MAX_CHARS;

/** Apply a stored setting. A missing or unusable value returns to the default. */
export function setPreviewMaxChars(v: unknown): void {
  maxChars = typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : DEFAULT_MAX_CHARS;
}

let popupSeq = 0;

/**
 * Cell renderer for long values: shows the value's PLAIN TEXT (markup stripped,
 * Markdown flattened) capped at `maxChars`, with a small gray popup icon on the
 * right of the column that opens the full RENDERED value in a resizable window.
 * Clicking the text opens a dialog to edit the source. The cell itself never
 * renders arbitrary HTML — only the popup does.
 *
 * A subclass decides how a value becomes markup ({@link toHtml}) and what the
 * popup window is called by default ({@link language}).
 */
export class PreviewCell extends HTMLElement {
  /** Fallback popup title, used when the column has no label. */
  protected readonly language: string = 'Preview';

  /**
   * The value as HTML, or `null` when it is plain text and must not be parsed as
   * markup — the popup then shows it verbatim in a `<pre>`.
   */
  protected toHtml(value: string): string | null {
    return value ? value : null;
  }

  private _value = '';
  /** The STORED cell, set by data-table only on a scripted column. */
  private _source: string | undefined;
  private _label: string | undefined;

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
    this._label = c?.label;
  }

  private get title_(): string {
    return this._label ?? this.language;
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
      empty.title = 'Click to edit';
      empty.addEventListener('click', () => this.openEditor());
      this.append(empty);
      return;
    }
    // Row layout: the truncated preview on the left, a spacer, then the popup
    // icon pinned to the right edge of the column.
    const wrap = document.createElement('span');
    wrap.style.cssText = 'display:flex;align-items:center;gap:0.25rem;width:100%';

    const view = document.createElement('span');
    // Show the value's PLAIN TEXT, not the rendered markup. Markdown is
    // converted first so its `#` and `**` markers do not show up as noise in a
    // line of text. Clicking edits the source in a dialog; the popup icon
    // (right) views the full rendered value.
    //
    // The line is cut by the COLUMN, not by a character count: the span below
    // ellipsizes with CSS, so the cell behaves like one with no renderer at all.
    // `maxChars` only bounds what is put in the DOM.
    const text = htmlToPreviewText(this.toHtml(this._value) ?? this._value);
    view.textContent = text.length > maxChars ? text.slice(0, maxChars) + '…' : text;
    view.title = 'Click to edit';
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
    const popout = iconButton(POPOUT_SVG, 'Open in a window');
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
    const html = this.toHtml(this._value);
    if (html !== null) {
      content.innerHTML = html;
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
      id: `easydb-preview-popup-${++popupSeq}`,
      container: popupContainer(),
      title: this.title_,
      color: '#7c3aed',
      content,
      // 520×400 is wider than a phone, so on mobile the popup opened partly
      // off-screen and had to be panned to be read. The rendered value is the
      // one thing you open this window to LOOK at, so on a narrow viewport it
      // starts maximized and fills the canvas. The 520×400 rect is still what
      // Restore returns to, so nothing is lost — it is the opening state that
      // changes, not the window.
      contentSize: { w: 520, h: 400 },
      position: { centerTopOffset: 60 },
      boot: { maximized: isMobileViewport() },
      // Read-and-dismiss, like a dialog: Escape closes it.
      closeOnEscape: true,
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
    openHtmlEditor(`Edit ${this.title_}`, scripted ? this._source! : this._value, (next) => {
      if (scripted) {
        this._source = next;
      } else {
        this._value = next;
        this.render();
      }
      this.dispatchEvent(
        new CustomEvent('change', { detail: { value: next }, bubbles: true, composed: true }),
      );
    });
  }
}
