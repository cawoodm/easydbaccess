// packages/renderer/src/util/column-script.ts
//
// Compiling and running a column's `script` — the JS body that must define
// `function render(row) { … }`. Shared by the two consumers so they agree on the
// calling convention and the cache:
//   - the `script` cell renderer (core-renderers), which injects the returned
//     string as raw HTML,
//   - data-table, which passes the returned VALUE to whatever renderer the
//     column uses (or shows it as text when there is none).
//
// DOM-free on purpose, so it is unit-testable and cannot drag the plugin loader
// into a test that only needs the script semantics.
//
// Trust model: the plugin host already lets user-supplied code do anything in
// the page, so a column script is no worse. The user authored it by clicking the
// pencil in the column editor.
//
// Besides `row`, a script can call the helpers listed in `HELPERS` below —
// currently `markdownToHtml(value)`. See its own module for why that one
// escapes HTML rather than passing it through.

import { markdownToHtml } from './markdown.js';

/** Outcome of one script run — never throws, so a broken script stays local. */
export type ScriptRun = { ok: true; value: unknown } | { ok: false; label: string; message: string };

/**
 * Helpers a column script can call by name, on top of the JS globals.
 *
 * They are passed as ARGUMENTS to the compiled wrapper rather than hung on
 * `window`: the script sees them as ordinary in-scope identifiers, nothing
 * leaks to the rest of the page, and this stays the single list of what a
 * script may rely on.
 *
 * `easydb` is the same set as a namespace, so a script can feature-detect
 * (`typeof easydb?.markdownToHtml === 'function'`) and so future helpers cost
 * a property rather than another parameter.
 */
const HELPERS = { markdownToHtml } as const;
const HELPER_NAMES = Object.keys(HELPERS);

/** What a column script receives besides `row`. Exported for the docs/editor. */
export const COLUMN_SCRIPT_HELPERS: ReadonlyArray<string> = HELPER_NAMES;

type Compiled = (row: unknown, ...helpers: unknown[]) => unknown;

const compiled = new Map<string, Compiled>();

/**
 * Compile a script body to `(row, …helpers) => unknown`, memoized per unique
 * source so a table of 10 000 rows compiles once. Throws on a syntax error.
 */
export function compileColumnScript(src: string): Compiled {
  const cached = compiled.get(src);
  if (cached) return cached;
  // The user's body defines `render`; we then call it with the bound row.
  // Wrapping in a function lets them also use `const` declarations, `Date`,
  // `Math` and so on, scoped to the call — and puts the helpers in scope for
  // the body AND for `render`, which closes over them.
  const fn = new Function('row', ...HELPER_NAMES, 'easydb', `${src}\nreturn render(row);`) as Compiled;
  compiled.set(src, fn);
  return fn;
}

/** The helper arguments, in the order `compileColumnScript` declares them. */
function helperArgs(): unknown[] {
  return [...HELPER_NAMES.map((n) => HELPERS[n as keyof typeof HELPERS]), HELPERS];
}

/**
 * Run a column script against one row's data. Distinguishes a compile error
 * from a runtime error so the cell can say which, and reports a blank script as
 * an error rather than silently rendering nothing.
 */
export function runColumnScript(src: string | undefined, row: unknown): ScriptRun {
  if (!src || !src.trim()) return { ok: false, label: 'no script', message: '' };
  let fn: Compiled;
  try {
    fn = compileColumnScript(src);
  } catch (err) {
    return { ok: false, label: 'compile error', message: errorMessage(err) };
  }
  try {
    return { ok: true, value: fn(row, ...helperArgs()) };
  } catch (err) {
    return { ok: false, label: 'runtime error', message: errorMessage(err) };
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// -- Validation scripts -------------------------------------------------------
//
// A column's OTHER script: `function validate(value, row) { … }`, run when the
// user edits a cell by hand. It rejects by THROWING — the message is what the
// grid shows — so the happy path is an empty return and there is no sentinel
// value to remember. Same helpers, same trust model, separate cache: the two
// kinds compile to different signatures, so one source string could otherwise
// come back compiled for the wrong one.

type CompiledValidator = (value: unknown, row: unknown, ...helpers: unknown[]) => unknown;

const compiledValidators = new Map<string, CompiledValidator>();

/**
 * Compile a validation body to `(value, row, …helpers) => void`, memoized per
 * unique source. Throws on a syntax error.
 */
export function compileValidateScript(src: string): CompiledValidator {
  const cached = compiledValidators.get(src);
  if (cached) return cached;
  const fn = new Function('value', 'row', ...HELPER_NAMES, 'easydb', `${src}\nreturn validate(value, row);`) as CompiledValidator;
  compiledValidators.set(src, fn);
  return fn;
}

/** Outcome of one validation run: `ok` unless the script rejected the value. */
export type ValidateRun = { ok: true } | { ok: false; message: string };

/**
 * Run a column's validation script against a proposed cell value.
 *
 * Rejection reasons and broken scripts both come back as `ok: false` with a
 * message, because to the person editing the cell they are the same event —
 * the edit didn't stick and here is why. A compile error is labelled as one so
 * the author can tell "your rule says no" from "your rule doesn't parse". A
 * blank script is not an error: there is simply nothing to check.
 */
export function runValidateScript(src: string | undefined, value: unknown, row: unknown): ValidateRun {
  if (!src || !src.trim()) return { ok: true };
  let fn: CompiledValidator;
  try {
    fn = compileValidateScript(src);
  } catch (err) {
    return { ok: false, message: `Validation script has a compile error: ${errorMessage(err)}` };
  }
  try {
    fn(value, row, ...helperArgs());
    return { ok: true };
  } catch (err) {
    // A `throw 'text'` (no Error) is as valid a rejection as `throw new Error`.
    return { ok: false, message: errorMessage(err) || 'Rejected by this column’s validation script.' };
  }
}
