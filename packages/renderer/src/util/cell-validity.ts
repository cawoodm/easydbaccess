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
