// packages/renderer/src/plugins/auto-renderer.ts
//
// easyDBAccess built-in plugin — picks a cell renderer for freshly imported
// columns from what the values actually look like: a URL gets `link`, an image
// URL gets `image`, markup or long prose gets `html-preview`.
//
// It listens on `import:after` rather than hooking any importer, so it applies
// to EVERY import path (CSV, JSON, Datasette, and anything a third-party plugin
// adds later) without those importers knowing it exists. Each importer keeps its
// own type inference; this only fills in a missing `renderer`.
//
// Like every non-fixed built-in it is user-toggleable, so someone who prefers
// plain text everywhere can switch the guessing off in the Plugin Manager.

import type { ColumnSpec, ColumnType, HostApi, PluginModule } from '@easydb/shared';

export const meta: NonNullable<PluginModule['meta']> = {
  id: 'auto-renderer',
  name: 'Auto Renderer',
  type: 'cell-renderer',
  version: '0.1.0',
  description:
    'After any import, gives columns a renderer based on their values: link for URLs, image for image URLs, html-preview for markup or long text.',
  author: 'Marc Cawood',
  icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9.5 3 8 6.5 4.5 8 8 9.5 9.5 13 11 9.5 14.5 8 11 6.5 9.5 3z"/><path d="M17.5 12 16.75 14 15 14.75 16.75 15.5 17.5 17.5 18.25 15.5 20 14.75 18.25 14 17.5 12z"/><path d="M4 17h9"/><path d="M4 21h6"/></svg>',
  repo: 'https://github.com/cawoodm/easydbaccess/blob/main/packages/renderer/src/plugins/auto-renderer.ts',
};

/**
 * Longest a string column can average before it counts as prose and gets the
 * html-preview renderer (truncated cell + a popup for the full value). Picked so
 * a title or a short description stays inline and a paragraph does not.
 */
const LONG_TEXT_CHARS = 120;

/** How many rows to look at. Enough to be sure, cheap on a big import. */
const SAMPLE_ROWS = 50;

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg|avif|bmp|ico)(\?|#|$)/i;
/** `<a>`, `<p class=…>`, `<br/>` — a real tag, not a bare `<` or "3 < 4". */
const HTML_TAG = /<[a-z][a-z0-9-]*(\s[^<>]*)?\/?>/i;

function isHttpUrl(s: string): boolean {
  return /^https?:\/\/\S+$/i.test(s);
}

function isImageValue(s: string): boolean {
  if (/^data:image\//i.test(s)) return true;
  return isHttpUrl(s) && IMAGE_EXT.test(s);
}

/**
 * The renderer a newly imported column should start with, or `undefined` for
 * none (plain text). Only string columns are considered: a `date` / `datetime` /
 * `boolean` column already gets its renderer from the importer's type inference,
 * and a number needs none.
 *
 * A rule fires only when EVERY sampled value agrees, so a mixed column is left
 * as plain text rather than guessed at. Long text is the exception — it uses the
 * average length, since prose columns vary.
 */
export function inferRenderer(type: ColumnType, samples: readonly unknown[]): string | undefined {
  if (type !== 'string') return undefined;

  const values: string[] = [];
  for (const v of samples) {
    if (v == null) continue;
    const s = typeof v === 'string' ? v.trim() : String(v).trim();
    if (!s) continue;
    values.push(s);
  }
  if (values.length === 0) return undefined;

  if (values.every(isImageValue)) return 'image';
  if (values.every(isHttpUrl)) return 'link';
  if (values.some((s) => HTML_TAG.test(s))) return 'html-preview';
  const avg = values.reduce((sum, s) => sum + s.length, 0) / values.length;
  if (avg > LONG_TEXT_CHARS) return 'html-preview';
  return undefined;
}

/**
 * Fill in a renderer on every column that has none, from the sampled rows. A
 * column that already carries one is returned untouched, so an importer's or a
 * user's choice is never overridden. Idempotent, and a no-op with no rows.
 */
export function withInferredRenderers(
  columns: readonly ColumnSpec[],
  rows: ReadonlyArray<Record<string, unknown>>,
): ColumnSpec[] {
  if (rows.length === 0) return [...columns];
  return columns.map((col) => {
    if (col.renderer) return col;
    const renderer = inferRenderer(
      col.type,
      rows.map((r) => r[col.field]),
    );
    return renderer ? { ...col, renderer } : col;
  });
}

export function init(api: HostApi): void {
  api.events.on('import:after', ({ tableId }) => {
    void applyToTable(api, tableId);
  });

  // The same guessing, on demand: an import that predates this plugin (or a
  // table typed by hand) has no renderers, and re-importing just to get them
  // would be silly. The result lands in the editor, not the store, so the user
  // reviews it and saves — see ColumnEditorActionSpec.
  api.ui.registerColumnEditorAction({
    id: 'auto-renderer:guess',
    label: 'Guess renderers',
    icon: 'auto_fix_high',
    tooltip: 'Pick a renderer for each column from what its values look like',
    async run(hostApi, { columns, tableId }) {
      // No table yet (a brand-new one being defined) means no values to learn
      // from, so there is nothing this can honestly do.
      if (!tableId) {
        hostApi.ui.dialogs.toast('Guessing needs rows to look at — import or add data first.', {
          kind: 'info',
          title: meta.name,
        });
        return null;
      }
      const rows = (await hostApi.store.rows(tableId).find()).slice(0, SAMPLE_ROWS);
      if (rows.length === 0) {
        hostApi.ui.dialogs.toast('This table has no rows to learn from yet.', {
          kind: 'info',
          title: meta.name,
        });
        return null;
      }
      // Ignore the columns' current renderers, unlike the import hook: pressing
      // the button IS the request to redo them.
      const bare = columns.map(({ renderer: _drop, ...rest }) => rest as ColumnSpec);
      const next = withInferredRenderers(
        bare,
        rows.map((r) => r.data),
      );
      const changed = next.filter((c, i) => c.renderer !== columns[i]?.renderer).length;
      hostApi.ui.dialogs.toast(
        changed === 0
          ? 'No renderer fits these values — columns left as they are.'
          : `Set ${changed} renderer${changed === 1 ? '' : 's'}. Press Save to keep them.`,
        { kind: changed === 0 ? 'info' : 'success', title: meta.name },
      );
      return next;
    },
  });
}

/**
 * Re-save the table with renderers filled in. Reads the rows back through the
 * store rather than taking them from the event, because the event carries only a
 * count — and reading is what makes this work for any importer.
 */
async function applyToTable(api: HostApi, tableId: string): Promise<void> {
  try {
    const table = await api.store.tables.findOne(tableId);
    if (!table || table.columns.length === 0) return;
    // Nothing to learn if every column already has a renderer — skip the read.
    if (table.columns.every((c) => c.renderer)) return;

    const rows = (await api.store.rows(tableId).find()).slice(0, SAMPLE_ROWS);
    if (rows.length === 0) return;

    const columns = withInferredRenderers(
      table.columns,
      rows.map((r) => r.data),
    );
    if (columns.every((c, i) => c.renderer === table.columns[i]?.renderer)) return;

    await api.store.tables.upsert({ ...table, columns, updatedAt: Date.now() });
  } catch (err) {
    // A failed guess must never break an otherwise-good import.
    api.events.emit('plugin:error', { url: meta.id, phase: 'runtime', error: err });
  }
}
