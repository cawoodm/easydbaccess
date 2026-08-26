// packages/renderer/src/table/renderer-options.ts
//
// Which cell renderers a picker offers.
//
// Two pickers need the same answer — the table's columns editor
// (`new-table-dialog.ts`) and a view's own columns editor
// (`view-columns-dialog.ts`) — and an answer that differed between them would
// read as one of the two being broken. Extracted when the second one arrived.

import { LEGACY_CELL_RENDERERS } from '../plugin-host/registries.js';

/**
 * Registered renderer names worth offering, sorted.
 *
 * Legacy aliases are left out: they still WORK, because a column saved under one
 * keeps rendering, but they are not what a new choice should be spelled as. See
 * `LEGACY_CELL_RENDERERS`.
 */
export function offerableRenderers(registered: ReadonlyMap<string, string>): string[] {
  return [...registered.keys()].filter((name) => !LEGACY_CELL_RENDERERS.has(name)).sort();
}

/**
 * The names to list for ONE column: the offerable ones, plus whatever it already
 * carries.
 *
 * Without that last part a column saved under a legacy or since-removed renderer
 * shows the empty option while still having one — so opening the editor and
 * saving would silently drop it.
 */
export function rendererOptionsFor(offered: readonly string[], current: string | undefined): string[] {
  return current && !offered.includes(current) ? [...offered, current] : [...offered];
}
