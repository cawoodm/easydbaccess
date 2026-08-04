/**
 * App-wide convention for a stored value that is not valid for its column.
 *
 * A renderer that hides the raw value behind a native input/checkbox has a
 * choice when the stored value doesn't fit: silently blank it, silently
 * coerce it, or show it. The first two lose data from the user's view — a
 * stored `'foo'` in a boolean column rendering as an unchecked box is
 * indistinguishable from a real `false`. This module is the one place every
 * renderer agrees on for "show it instead": red-bordered raw text plus a
 * `title` naming the problem, never a blank/coerced default.
 *
 * Reuses the existing invalid-field red from
 * `dialogs/settings-dialog.ts`'s `.invalid` rule (`border-color: #dc2626`)
 * so the app has exactly one "this is wrong" colour.
 */

import { arrayMembers } from '@easydb/shared';

/** The one invalid-value red used everywhere. Do not introduce another. */
export const INVALID_COLOR = '#dc2626';

/**
 * Marker class for anything carrying the invalid-value treatment — useful
 * for tests to target the marked element without depending on DOM shape.
 * Purely a hook; the visual comes from the inline styles below.
 */
export const INVALID_CLASS = 'cell-invalid';

/**
 * Inline `style` fragment for a lit-template call site (bind via
 * `style=${INVALID_INPUT_STYLE}`). Mirrors `.secret-row input.invalid` in
 * `settings-dialog.ts` — same border + background — so a plain `<input>`
 * marked invalid looks identical everywhere.
 */
export const INVALID_INPUT_STYLE = `border-color:${INVALID_COLOR};background:#fef2f2`;

/**
 * Applies the invalid marking to a DOM element built by hand (not a lit
 * template) — a red border plus an optional `title` explaining why.
 */
export function markInvalid(el: HTMLElement, reason?: string): void {
  el.classList.add(INVALID_CLASS);
  el.style.border = `1px solid ${INVALID_COLOR}`;
  el.style.background = '#fef2f2';
  if (reason) el.title = reason;
}

export type CellState = 'ok' | 'empty' | 'invalid';

/**
 * Classify a stored value against its column type for the grid's own
 * highlighting: an empty cell gets a pink background, a value that does not fit
 * the type a red outline.
 *
 * This is the GLOBAL baseline, applied on the `<td>` whatever renderer the column
 * has — a renderer that draws a checkbox or an image cannot show "there is
 * nothing here" or "this does not parse" on its own. Type-specific renderers keep
 * their own in-cell marking (see `markInvalid`); the two agree because both key
 * off the same rules.
 */
export function cellState(value: unknown, type?: string): CellState {
  if (value == null) return 'empty';
  if (typeof value === 'string' && value.trim() === '') return 'empty';
  switch (type) {
    case 'boolean':
      return booleanState(value) === 'invalid' ? 'invalid' : 'ok';
    case 'number':
      // A number column holding `12abc` is a broken import, not a 12.
      return Number.isFinite(typeof value === 'number' ? value : Number(value)) ? 'ok' : 'invalid';
    case 'date':
    case 'datetime':
      return Number.isNaN(Date.parse(String(value))) ? 'invalid' : 'ok';
    case 'array':
      // `[]` and `""` are both "no values here" — an array cell is empty when it
      // has no members, whichever of the three spellings it uses. Nothing about
      // an array is ever invalid: unparseable JSON reads as a comma list.
      return arrayMembers(value).length === 0 ? 'empty' : 'ok';
    default:
      // A string column takes anything — only emptiness is worth marking.
      return 'ok';
  }
}

export type BooleanState = 'true' | 'false' | 'empty' | 'invalid';

const TRUE_RE = /^\s*(true|1)\s*$/i;
const FALSE_RE = /^\s*(false|0)\s*$/i;

/**
 * Classifies a stored value for the boolean renderer into one of four
 * states. Case-insensitive on purpose: CSV imports routinely produce
 * `True`/`FALSE`, and flagging those invalid would punish a normal import
 * rather than a genuinely bad value.
 */
export function booleanState(v: unknown): BooleanState {
  if (v === true || v === 1) return 'true';
  if (v === false || v === 0) return 'false';
  if (v == null) return 'empty';
  if (typeof v === 'string') {
    if (v.trim() === '') return 'empty';
    if (TRUE_RE.test(v)) return 'true';
    if (FALSE_RE.test(v)) return 'false';
    return 'invalid';
  }
  // Anything else — other numbers, objects, arrays, NaN — is invalid.
  return 'invalid';
}
