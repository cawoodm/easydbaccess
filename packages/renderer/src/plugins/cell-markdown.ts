import type { HostApi, PluginModule } from '@easydb/shared';
import { markdownToHtml } from '../util/markdown.js';
import { MarkupCell } from './markup-cell.js';

// The "markdown" cell renderer: the cell is written in Markdown and shown as
// formatted text, in full. The `preview` renderer also converts Markdown, but
// only to a bounded ONE-LINE plain-text summary, with the formatted value behind
// a popup — the choice between them is "read it in the grid" (markdown) versus
// "keep the row one line high" (preview).

export const meta: NonNullable<PluginModule['meta']> = {
  id: 'cell-markdown',
  name: 'Markdown',
  type: 'cell-renderer',
  version: '0.1.0',
  description:
    'Renders a cell written in Markdown as formatted text, in full; a pencil on the right edits the Markdown source. Apply by setting a column\'s renderer to "markdown". For a one-line summary with a popup use "preview".',
  author: 'Marc Cawood',
  icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="5" width="20" height="14" rx="2"/><path d="M6 15V9l3 3 3-3v6"/><path d="M16 9v6"/><path d="M14 13l2 2 2-2"/></svg>',
  repo: 'https://github.com/cawoodm/easydbaccess/blob/main/packages/renderer/src/plugins/cell-markdown.ts',
};

export function init(api: HostApi): void {
  if (!customElements.get('markdown-cell')) {
    customElements.define('markdown-cell', MarkdownCell);
  }
  api.ui.registerCellRenderer('markdown', 'markdown-cell');
}

/**
 * Cell renderer for a Markdown column: {@link MarkupCell} with the conversion
 * step in front of it, so the pencil still opens the MARKDOWN and never the HTML
 * that was made from it — nothing here writes the converted value back.
 */
class MarkdownCell extends MarkupCell {
  protected override readonly language = 'Markdown';

  protected override toHtml(value: string): string {
    return markdownToHtml(value);
  }
}
