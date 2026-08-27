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
import { PENCIL_SVG, popupContainer } from './html-cell-editor.js';

let popupSeq = 0;

/**
 * The bar above a preview, and the way out of a read-only window.
 *
 * A preview is deliberately not editable — see the note at the top of this file
 * about why a grid cell renderer is not mounted here as an editor. That left the
 * window a dead end: a reader who opened a value BECAUSE it was too long for its
 * cell, then saw the typo in it, had to close the window, find the cell again and
 * click its text. The header says what is being shown and offers the same source
 * editor the cell offers, which is the one editor that is safe here: a textarea
 * over the STORED value, not a live renderer over the computed one.
 */
export interface PreviewHeaderSpec {
  /** What the window is showing — the column's label. */
  label: string;
  /** Which record, where the window was opened without one on screen. */
  note?: string | undefined;
  /** Opens the editor. Omitted ⇒ no button, and no header worth drawing. */
  onEdit?: (() => void) | undefined;
  /** `Edit`, or `View source` where the value may not be written. */
  editLabel?: string | undefined;
}

export function previewHeader(spec: PreviewHeaderSpec): HTMLElement {
  const bar = document.createElement('div');
  bar.className = 'eda-preview-header';
  bar.style.cssText = 'flex:none;display:flex;align-items:center;gap:0.5rem;padding:0.35rem 0.6rem;' + 'border-bottom:1px solid #e5e7eb;background:#f9fafb;font-size:0.8rem;color:#374151';

  const label = document.createElement('span');
  label.textContent = spec.label;
  label.style.cssText = 'font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis';
  bar.append(label);

  if (spec.note) {
    const note = document.createElement('span');
    note.textContent = spec.note;
    note.style.cssText = 'color:#9ca3af;white-space:nowrap;overflow:hidden;text-overflow:ellipsis';
    bar.append(note);
  }

  const spacer = document.createElement('span');
  spacer.style.cssText = 'flex:1 1 auto';
  bar.append(spacer);

  if (spec.onEdit) {
    const text = spec.editLabel ?? 'Edit';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.title = `${text} ${spec.label}`;
    // The visible text is the accessible name, so it reads as one button rather
    // than as an icon with a second label beside it.
    btn.innerHTML = `${PENCIL_SVG}<span>${text}</span>`;
    btn.style.cssText =
      'flex:none;display:inline-flex;align-items:center;gap:0.3rem;padding:0.15rem 0.5rem;' +
      'font:inherit;color:#4b5563;background:#fff;border:1px solid #d1d5db;border-radius:0.25rem;cursor:pointer';
    btn.addEventListener('click', () => spec.onEdit?.());
    bar.append(btn);
  }

  return bar;
}

/**
 * Open `content` in the preview window, under an optional {@link previewHeader}.
 *
 * 520×400 is wider than a phone, so on mobile the popup opened partly off-screen
 * and had to be panned to be read. The value is the one thing this window exists
 * to show, so on a narrow viewport it starts maximized and fills the canvas. The
 * 520×400 rect is still what Restore returns to — it is the opening state that
 * changes, not the window.
 */
export function openPreviewPopup(title: string, content: HTMLElement, header?: PreviewHeaderSpec): void {
  createPanel({
    id: `easydb-preview-popup-${++popupSeq}`,
    container: popupContainer(),
    title,
    color: '#7c3aed',
    content: header ? withHeader(previewHeader(header), content) : content,
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
 * Header on top, value below, and the value is what scrolls.
 *
 * `previewFrame` is already the scroller, so it only needs to stop claiming the
 * full height it was given when it was the whole content — a flex child with
 * `height:100%` and a sibling overflows its parent instead of sharing it.
 */
function withHeader(header: HTMLElement, body: HTMLElement): HTMLElement {
  const shell = document.createElement('div');
  shell.style.cssText = 'display:flex;flex-direction:column;height:100%;box-sizing:border-box';
  body.style.height = 'auto';
  body.style.flex = '1 1 auto';
  body.style.minHeight = '0';
  shell.append(header, body);
  return shell;
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
