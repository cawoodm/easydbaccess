// packages/renderer/src/plugins/preview-popup.ts
//
// The window a preview opens in, and the one place that decides what goes in it.
//
// Two callers, and it matters that they are the SAME window: the popup icon in a
// `preview` / `markdown` cell, and the `preview/…` commandlet. A commandlet that
// built its own panel would drift — a different size, a different colour, its own
// idea of Escape — and a user following a link from a view would land somewhere
// that does not look like the popup they know from the grid.
//
// `renderValue` mounts the column's own registered renderer where that renderer
// has said it can be shown OUTSIDE a grid row — which it says by defining
// `expanded`. Today that is `preview` and `markdown`, the two whose whole job is
// a long value behind a popup, and they are exactly the columns worth a window.
//
// Every other renderer falls back to the value as text, on purpose. A grid cell
// renderer is built to sit in a one-line row and, more importantly, several of
// them draw an EDITOR: `link` renders a bare value as an `<input>`. A preview
// window is for reading a record that may not even be on screen, so an edit box
// in it is at best confusing and at worst a write to a table the user is not
// looking at.

import { createPanel } from '../window-mgr/panel-shell/panel-shell.js';
import { shellViewport } from '../window-mgr/shell-viewport.js';
import { isMobileViewport } from '../util/viewport.js';
import { popupContainer } from './html-cell-editor.js';

let popupSeq = 0;

/**
 * Open `content` in the preview window.
 *
 * 520×400 is wider than a phone, so on mobile the popup opened partly off-screen
 * and had to be panned to be read. The value is the one thing this window exists
 * to show, so on a narrow viewport it starts maximized and fills the canvas. The
 * 520×400 rect is still what Restore returns to — it is the opening state that
 * changes, not the window.
 */
export function openPreviewPopup(title: string, content: HTMLElement): void {
  createPanel({
    id: `easydb-preview-popup-${++popupSeq}`,
    container: popupContainer(),
    title,
    color: '#7c3aed',
    content,
    contentSize: { w: 520, h: 400 },
    position: { centerTopOffset: 60 },
    boot: { maximized: isMobileViewport() },
    // Read-and-dismiss, like a dialog: Escape closes it.
    closeOnEscape: true,
    minimizeTo: '#easydb-minimized-dock',
    viewport: shellViewport(),
  });
}

/** The padded, scrollable box every preview window's content sits in. */
export function previewFrame(): HTMLElement {
  const el = document.createElement('div');
  el.style.cssText = 'padding:0.75rem;overflow:auto;height:100%;box-sizing:border-box';
  return el;
}

/**
 * Plain text in a `<pre>` — the fallback, and the right answer for a value that
 * is NOT markup.
 *
 * `textContent` rather than `innerHTML`: it keeps the newlines and indentation a
 * `<pre>` exists for, and escapes any `<` or `&` in the data instead of letting
 * the browser parse them as tags. A CSV cell containing `<script>` is data.
 */
export function preformatted(value: string): HTMLElement {
  const pre = document.createElement('pre');
  pre.style.cssText = 'white-space:pre-wrap;word-break:break-word;margin:0;font-family:ui-monospace, monospace;';
  pre.textContent = value;
  return pre;
}

/**
 * One cell's value, drawn the way its column would draw it — where the column's
 * renderer is one that can leave a grid row.
 *
 * `expanded` is the capability test, and it is a real one rather than a name
 * check: a renderer defines that property to say "I know I may be more than one
 * line high". Asking the element itself means a plugin's own renderer opts in the
 * same way the built-in ones do, and a renderer that has not thought about it
 * cannot be mounted somewhere it was never designed for. The check runs BEFORE
 * anything is assigned, because assigning `expanded` would create the very
 * property being looked for.
 *
 * The three properties set on an opted-in renderer are each load-bearing:
 *
 *  - `expanded` — draw the value, not the one-line summary of it. Without this a
 *    `markdown` column previews as the same flattened line the cell already
 *    shows, which is precisely what the reader opened the popup to escape.
 *  - `readonly` / `sourceReadonly` — a preview is for READING.
 *  - `column` — the label the renderer titles itself with, and its type.
 */
export function renderValue(value: unknown, column: { field: string; label?: string; renderer?: string | undefined } | undefined, renderers: Map<string, string>): HTMLElement {
  const text = value == null ? '' : String(value);
  const tag = column?.renderer ? renderers.get(column.renderer) : undefined;
  if (!tag) return preformatted(text);
  const el = document.createElement(tag) as HTMLElement & Record<string, unknown>;
  // Also catches a renderer whose element is not defined (a plugin that failed to
  // load): `createElement` still returns an element, and it has no `expanded`.
  if (!('expanded' in el)) return preformatted(text);
  el.column = column;
  el.value = text;
  el.rawValue = text;
  el.readonly = true;
  el.sourceReadonly = true;
  el.expanded = true;
  return el;
}
