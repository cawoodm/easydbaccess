import type { HostApi, PluginModule } from '@easydb/shared';
import { markdownToHtml } from '../util/markdown.js';
import { PreviewCell } from './preview-cell.js';

// The "markdown" cell renderer: the cell is Markdown. Inline it reads as ONE LINE
// of plain text with the markers flattened out — a grid row is one line high, and
// headings, lists and images each setting their own row height is not a grid. The
// formatted value opens in the popup, exactly as `preview` shows it.
//
// The difference from `preview` is that this renderer never GUESSES: `preview`
// asks `markupKind` what a value is, while a `markdown` column is declared, so a
// value that reads like HTML is still converted as Markdown.

export const meta: NonNullable<PluginModule['meta']> = {
  id: 'cell-markdown',
  name: 'Markdown',
  type: 'cell-renderer',
  version: '0.2.0',
  description:
    'For a column written in Markdown: the cell shows one line of plain text with the markers flattened, and the popup icon opens the formatted value in a window. Click the text to edit the Markdown source. Apply by setting a column\'s renderer to "markdown". Unlike "preview" it never guesses — the value is always read as Markdown.',
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
 * A {@link PreviewCell} with the guess removed: every value goes through
 * `markdownToHtml`. Nothing writes the converted value back — the editor opens
 * the Markdown, as it does for a `preview` column.
 */
class MarkdownCell extends PreviewCell {
  protected override readonly language = 'Markdown';

  protected override toHtml(value: string): string | null {
    return value ? markdownToHtml(value) : null;
  }
}
