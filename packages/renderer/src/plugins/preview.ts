import type { HostApi, PluginModule } from '@easydb/shared';
import { markdownToHtml, markupKind } from '../util/markdown.js';
import { DEFAULT_MAX_CHARS, PreviewCell, setPreviewMaxChars } from './preview-cell.js';

export const meta: NonNullable<PluginModule['meta']> = {
  id: 'preview',
  name: 'Preview',
  type: 'cell-renderer',
  version: '0.4.0',
  description:
    'Shows a long value as a plain-text preview (first N characters); click to edit the source in a dialog, or use the popup icon to open the full value in a window. HTML is shown there as markup, and Markdown is recognised and converted first — so a Markdown column reads as formatted text without a script. Apply by setting a column\'s renderer to "preview". For direct in-cell rendering use the "html" renderer instead.',
  author: 'Marc Cawood',
  icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>',
  repo: 'https://github.com/cawoodm/easydbaccess/blob/main/packages/renderer/src/plugins/preview.ts',
};

async function refreshMaxChars(api: HostApi): Promise<void> {
  // Read under the `preview` id. A workspace that set this number while the
  // plugin was still `html-preview` (to v0.0.281) is back on the default:
  // `settings.get` resolves the field default, so a value under the old id
  // cannot be told apart from one that was never set.
  setPreviewMaxChars(await api.settings.get<number>('preview', 'maxChars'));
}

export function init(api: HostApi): void {
  if (!customElements.get('preview-cell')) {
    customElements.define('preview-cell', PreviewGuessCell);
  }
  api.ui.registerCellRenderer('preview', 'preview-cell');
  // Columns saved before the rename still say `html-preview`, so the old name
  // stays a working alias. The columns editor hides it — see
  // LEGACY_CELL_RENDERERS — so it is never offered as a new choice.
  api.ui.registerCellRenderer('html-preview', 'preview-cell');
  api.ui.registerSettings('preview', 'Preview', [
    {
      key: 'maxChars',
      label: 'Max characters shown',
      type: 'number',
      default: DEFAULT_MAX_CHARS,
      scope: 'workspace',
      description:
        'A safety cap on how much text goes into a preview cell. What you SEE follows the column width — the cell ellipsizes like any other, so widen the column to read more. Lower this only to cut long values short regardless of width. Applies to cells rendered after the change (reload to refresh all). Shared with the `markdown` renderer.',
    },
  ]);
  void refreshMaxChars(api);
  api.events.on('app:ready', () => void refreshMaxChars(api));
}

/**
 * The `preview` cell: a {@link PreviewCell} that GUESSES the language, because it
 * renders columns nobody configured.
 *
 * Markdown is converted rather than left to a column script: a Markdown column is
 * just data, and the value carries enough evidence to recognise itself. Which
 * language wins is `markupKind`'s decision — Markdown first, because prose
 * mentioning `<database>` is not an HTML document. A column that IS Markdown and
 * should never be guessed at takes the `markdown` renderer instead.
 */
class PreviewGuessCell extends PreviewCell {
  protected override toHtml(value: string): string | null {
    const kind = markupKind(value);
    if (kind === 'html') return value;
    return kind === 'markdown' ? markdownToHtml(value) : null;
  }
}
