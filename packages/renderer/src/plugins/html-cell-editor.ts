// packages/renderer/src/plugins/html-cell-editor.ts
//
// The source editor shared by the two markup cell renderers (`html` and
// `preview`). Both show a value they cannot be typed into — one renders it
// as markup, the other strips it to one line — so both need the same way in: a
// pencil that opens the SOURCE in a textarea.
//
// "Source" is the load-bearing word. On a scripted column the cell shows the
// script's OUTPUT, and saving that output over the stored cell would destroy the
// Markdown or HTML the script reads. So the caller passes the stored value, not
// the displayed one, and the change event carries the stored value back.

import { createPanel } from '../window-mgr/panel-shell/panel-shell.js';
import { shellViewport } from '../window-mgr/jspanel-manager.js';
import { isMobileViewport } from '../util/viewport.js';

/** The pan/zoom-transformed canvas viewport that panels mount into. */
export function popupContainer(): HTMLElement {
  return document.getElementById('easydb-panels-viewport') ?? document.getElementById('easydb-panels') ?? document.body;
}

let editSeq = 0;

/** A small gray icon button, the shape both renderers use in a cell. */
export function iconButton(svg: string, title: string): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.title = title;
  btn.setAttribute('aria-label', title);
  btn.innerHTML = svg;
  btn.style.cssText =
    'flex:none;display:inline-flex;align-items:center;justify-content:center;padding:1px;background:none;border:0;color:#9ca3af;cursor:pointer;line-height:0';
  btn.addEventListener('mouseenter', () => (btn.style.color = '#4b5563'));
  btn.addEventListener('mouseleave', () => (btn.style.color = '#9ca3af'));
  return btn;
}

export const PENCIL_SVG =
  '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>';

export const POPOUT_SVG =
  '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 3h7v7"/><path d="M21 3l-9 9"/><path d="M19 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h6"/></svg>';

/** Edit a cell's raw source in a textarea panel. Save calls `onSave`. */
export function openHtmlEditor(title: string, value: string, onSave: (next: string) => void): void {
  const content = document.createElement('div');
  content.style.cssText = 'display:flex;flex-direction:column;gap:0.5rem;height:100%;box-sizing:border-box;padding:0.5rem';
  const ta = document.createElement('textarea');
  ta.value = value;
  ta.style.cssText = 'flex:1 1 auto;width:100%;box-sizing:border-box;resize:none;font-family:monospace;font-size:0.85rem';
  const bar = document.createElement('div');
  bar.style.cssText = 'display:flex;justify-content:flex-end;gap:0.5rem;flex:none';
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.textContent = 'Cancel';
  cancel.style.cssText = 'padding:0.3rem 0.8rem;cursor:pointer';
  const save = document.createElement('button');
  save.type = 'button';
  save.textContent = 'Save';
  save.style.cssText = 'padding:0.3rem 0.8rem;cursor:pointer;background:#7c3aed;color:#fff;border:0;border-radius:0.25rem';
  bar.append(cancel, save);
  content.append(ta, bar);

  const panel = createPanel({
    id: `easydb-html-edit-${++editSeq}`,
    container: popupContainer(),
    title,
    color: '#7c3aed',
    content,
    contentSize: { w: 520, h: 400 },
    position: 'center',
    // A textarea whose edge you cannot see is hard to type into, and the
    // Save/Cancel buttons sit in the corner a too-wide panel pushes off-screen
    // first. So on a narrow viewport the editor opens maximized. The 520x400
    // rect stays what Restore returns to.
    boot: { maximized: isMobileViewport() },
    minimizeTo: '#easydb-minimized-dock',
    viewport: shellViewport(),
  });

  cancel.addEventListener('click', () => panel.close());
  save.addEventListener('click', () => {
    onSave(ta.value);
    panel.close();
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
