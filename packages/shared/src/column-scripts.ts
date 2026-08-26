// packages/shared/src/column-scripts.ts
//
// "Does this column have a script to run, and may it run?" — asked identically
// by the grid, exports, views, visualizations, search and validation.
//
// A column carries two scripts (`script`, which computes what the cell shows,
// and `validate`, which vetoes a manual edit) and each has a switch beside it
// (`scriptActive`, `validateActive`). ABSENT MEANS ON, so every column written
// before the switch existed keeps running its script.
//
// The whole point of putting this here is that the switch is worthless if one
// reader forgets it. A caller that writes `col.script?.trim()` gets a script the
// user switched off, silently — the column editor says red and the grid runs it
// anyway. So the rule is: nothing reads `script` / `validate` directly; every
// reader asks one of these two, and gets back the source only when it should
// actually run.
//
// They live in shared rather than the renderer because `edb-store` and the
// Electron main process see the same ColumnSpec, and a second copy of a
// default-on rule is exactly the kind of thing that drifts to default-off.

import type { ColumnSpec } from './types.js';

/**
 * The render script to run for this column, or `undefined` when there is none
 * to run — either because none is set or because the user switched it off.
 *
 * Blank and whitespace-only bodies count as "none": that is what the column
 * editor stores when the script is cleared, and running one would report a
 * "no script" error into every cell.
 */
export function activeColumnScript(col: Pick<ColumnSpec, 'script' | 'scriptActive'> | undefined): string | undefined {
  if (!col || col.scriptActive === false) return undefined;
  return col.script?.trim() ? col.script : undefined;
}

/** The validation rule to run for this column, on the same terms. */
export function activeValidateScript(col: Pick<ColumnSpec, 'validate' | 'validateActive'> | undefined): string | undefined {
  if (!col || col.validateActive === false) return undefined;
  return col.validate?.trim() ? col.validate : undefined;
}

/**
 * The three states the column editor's two script buttons paint, and the only
 * place the vocabulary is defined.
 *
 * `off` exists to be VISIBLE. A parked script is still the author's work and
 * still travels with the table; a button that showed it as "none" would invite
 * writing the rule a second time.
 */
export type ScriptState = 'on' | 'off' | 'none';

/** Which of the three a body-plus-switch pair is in. */
export function scriptState(src: string | undefined, active: boolean | undefined): ScriptState {
  if (!src?.trim()) return 'none';
  return active === false ? 'off' : 'on';
}
