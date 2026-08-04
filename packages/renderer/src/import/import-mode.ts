// packages/renderer/src/import/import-mode.ts
//
// One question, asked the same way by every importer: this file names a table
// that already exists (it was dropped ON its window, or it carries its name) —
// what should happen to that table?
//
// Each importer used to ask its own version. CSV offered "Append rows /
// Overwrite rows / Create as new table", a dropped CSV offered the same three in
// different words, and a JSON dump offered "Overwrite matching / Replace entire
// workspace / Add as new tables". None of them offered the one thing a stale
// table most often needs: taking the FILE's columns, not just its rows.

import type { ColumnSpec, HostApi } from '@easydb/shared';
import { slugField } from '../util/ids.js';

/**
 * What to do with the table a file lands on.
 *
 *  - `recreate` — the file decides everything: its columns REPLACE the table's
 *    and its rows replace the data. The table keeps its id, name and window, so
 *    a projection or view bound to it survives what is otherwise a re-import.
 *  - `reload` — the table's columns stay (widths, renderers, types, scripts);
 *    only the rows are replaced.
 *  - `append` — the rows are added after the ones already there.
 *  - `new` — leave that table alone and make another one.
 */
export type ImportOntoMode = 'recreate' | 'reload' | 'append' | 'new';

// The labels are constants because a choice dialog reports back the label the
// user picked. They say what happens to the DATA, since that is the part that
// cannot be undone.
const RECREATE = 'Re-Create: columns and rows from the file';
const RELOAD = 'Re-Load: replace the rows, keep the columns';
const APPEND = 'Append the rows';
const NEW = 'A new table';

const BY_LABEL: Record<string, ImportOntoMode> = {
  [RECREATE]: 'recreate',
  [RELOAD]: 'reload',
  [APPEND]: 'append',
  [NEW]: 'new',
};

/**
 * Ask what to do with `tableName`, which `fileName` is about to be imported
 * into. Returns null when the user dismissed the dialog — that cancels the
 * import; it does not fall through to some default.
 */
export async function askImportOntoMode(api: HostApi, opts: { fileName: string; tableName: string; title: string; reason?: string | undefined }): Promise<ImportOntoMode | null> {
  const reason = opts.reason ?? `Import "${opts.fileName}" into "${opts.tableName}"?`;
  const choice = await api.ui.dialogs.choice(reason, [RECREATE, RELOAD, APPEND, NEW], opts.title);
  return choice ? (BY_LABEL[choice] ?? null) : null;
}

/**
 * Do the file's incoming columns line up with the table's, so the rows can be
 * mapped without asking?
 *
 * "Line up" means same count and, at every position, the same column: the
 * incoming name matches the target's field, its label, or the slug of either.
 * That is the case a file the table was imported FROM falls into, and it is the
 * only case where the historical by-position mapping is safe — any other shape
 * needs the column mapper, or cells land silently under the wrong columns.
 */
export function columnsLineUp(incoming: readonly string[], targetCols: readonly ColumnSpec[]): boolean {
  if (incoming.length !== targetCols.length) return false;
  return incoming.every((name, i) => {
    const col = targetCols[i]!;
    const candidates = [col.field, col.label, slugField(col.field), slugField(col.label ?? '')];
    const n = name.trim().toLowerCase();
    return candidates.some((c) => c.trim().toLowerCase() === n) || slugField(name) === col.field;
  });
}
