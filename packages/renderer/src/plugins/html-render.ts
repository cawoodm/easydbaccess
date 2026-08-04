import type { HostApi, PluginModule } from '@easydb/shared';
import { MarkupCell } from './markup-cell.js';

// The "html" cell renderer: renders a cell's value directly as HTML, in full,
// with no truncation and no popup. This is the simple, unguarded option — the
// markup is trusted to be well-behaved. For a safe, bounded plain-text preview
// (with a popup for the full value) use the separate `preview` plugin; for a
// column written in Markdown use `markdown`.

export const meta: NonNullable<PluginModule['meta']> = {
  id: 'html-render',
  name: 'HTML',
  type: 'cell-renderer',
  version: '0.1.0',
  description:
    'Renders a cell\'s value directly as HTML (unescaped, in full, no popup); a pencil on the right edits the source. Apply by setting a column\'s renderer to "html". For a truncated preview use "preview".',
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
 * Cell renderer that puts the value's HTML straight in the cell, in full. The
 * whole behaviour — the pencil, the scripted-column source, the "empty"
 * placeholder — lives in {@link MarkupCell}; an `html` column needs no
 * conversion, so it adds nothing but its name.
 */
class HtmlRenderCell extends MarkupCell {}
