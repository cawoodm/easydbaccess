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

import { htmlToPreviewText } from '../util/html-text.js';
import { iconButton, openHtmlEditor, POPOUT_SVG } from './html-cell-editor.js';
import { openPreviewPopup, preformatted, previewFrame } from './preview-popup.js';

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
  /** The STORED value may not be written: show the source, offer no edit. */
  private _readonly = false;

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

  /**
   * data-table binds `.sourceReadonly` when the STORED value may not be written:
   * a read-only table or view, or a read-only column. The cell still opens its
   * source — reading a value the column is too narrow for is the whole point —
   * but as a viewer.
   *
   * Deliberately NOT `.readonly`, which a scripted column always sets: there the
   * displayed value is computed and uneditable while the source behind it is
   * still fair game (that is what the pencil is for). The two mean different
   * things, so they are different properties.
   */
  set sourceReadonly(v: boolean) {
    const next = v === true;
    if (this._readonly === next) return;
    this._readonly = next;
    this.render();
  }
  get sourceReadonly(): boolean {
    return this._readonly;
  }

  /**
   * Mounted somewhere a value may be more than one line high — a view.
   *
   * The one-line cell is a GRID constraint, not what this renderer means: a row
   * is one line tall and arbitrary markup would have every row set its own
   * height, so the cell holds text and the popup holds the render. A view is a
   * page of HTML the template author laid out; nothing there is one line high,
   * and a `$TOKEN` on a markdown column that showed flattened text looked as if
   * the renderer had not been applied at all.
   *
   * So the same element renders in place when it is told it is not in a grid.
   * Set by `views/view-window.ts` when it mounts the cell; `data-table` never
   * sets it, and every other renderer ignores the property.
   */
  set expanded(v: boolean) {
    const next = v === true;
    if (this._expanded === next) return;
    this._expanded = next;
    this.render();
  }
  get expanded(): boolean {
    return this._expanded;
  }
  private _expanded = false;

  private get title_(): string {
    return this._label ?? this.language;
  }

  /**
   * The value as a block: the markup where there is any, else the text verbatim
   * in a `<pre>`.
   *
   * The same two cases `openWindow` draws, and for the same reason — a value that
   * is NOT markup must not be parsed as markup, and `textContent` both preserves
   * its newlines and escapes its `<` and `&`.
   */
  private renderedBlock(): HTMLElement {
    const block = document.createElement('div');
    const html = this.toHtml(this._value);
    if (html !== null) {
      block.innerHTML = html;
      return block;
    }
    const pre = document.createElement('pre');
    pre.style.cssText = 'white-space:pre-wrap;word-break:break-word;margin:0;font-family:ui-monospace, monospace;';
    pre.textContent = this._value;
    block.append(pre);
    return block;
  }

  connectedCallback() {
    this.render();
  }

  private render() {
    this.innerHTML = '';
    // Outside a grid row: draw the value, with no popup icon and nothing to
    // click. A view is read-only — editing is what `$input.TOKEN` is for.
    if (this._expanded) {
      if (this._value) this.append(this.renderedBlock());
      return;
    }
    if (!this._value) {
      const empty = document.createElement('span');
      empty.style.cssText = this._readonly ? 'color:#9ca3af' : 'color:#9ca3af;cursor:text';
      empty.textContent = 'empty';
      // Nothing to read and nothing to write: a read-only empty cell is inert.
      if (!this._readonly) {
        empty.title = 'Click to edit';
        empty.addEventListener('click', () => this.openEditor());
      }
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
    view.title = this._readonly ? 'Click to view the source' : 'Click to edit';
    view.style.cssText = 'flex:0 1 auto;min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;cursor:text';
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
    const content = previewFrame();
    const html = this.toHtml(this._value);
    if (html !== null) content.innerHTML = html;
    else content.append(preformatted(this._value));
    openPreviewPopup(this.title_, content);
  }

  /**
   * Edit the SOURCE in a textarea panel. On a scripted column that is the
   * stored cell (`rawValue`), not the script output shown in the popup —
   * saving the output would overwrite the Markdown or HTML the script reads.
   */
  private openEditor() {
    const scripted = this._source !== undefined;
    const source = scripted ? this._source! : this._value;
    // Read-only: the same panel, opened to READ. Nothing here can save, and the
    // core refuses the write anyway (see data-table's `commitCell`).
    if (this._readonly) {
      openHtmlEditor(`View ${this.title_}`, source, () => undefined, { readonly: true });
      return;
    }
    openHtmlEditor(`Edit ${this.title_}`, source, (next) => {
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
