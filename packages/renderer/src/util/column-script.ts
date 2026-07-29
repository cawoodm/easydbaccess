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

/** Outcome of one script run — never throws, so a broken script stays local. */
export type ScriptRun =
  | { ok: true; value: unknown }
  | { ok: false; label: string; message: string };

const compiled = new Map<string, (row: unknown) => unknown>();

/**
 * Compile a script body to `(row) => unknown`, memoized per unique source so a
 * table of 10 000 rows compiles once. Throws on a syntax error.
 */
export function compileColumnScript(src: string): (row: unknown) => unknown {
  const cached = compiled.get(src);
  if (cached) return cached;
  // The user's body defines `render`; we then call it with the bound row.
  // Wrapping in a function lets them also use `const` declarations, `Date`,
  // `Math` and so on, scoped to the call.
  const fn = new Function('row', `${src}\nreturn render(row);`) as (row: unknown) => unknown;
  compiled.set(src, fn);
  return fn;
}

/**
 * Run a column script against one row's data. Distinguishes a compile error
 * from a runtime error so the cell can say which, and reports a blank script as
 * an error rather than silently rendering nothing.
 */
export function runColumnScript(src: string | undefined, row: unknown): ScriptRun {
  if (!src || !src.trim()) return { ok: false, label: 'no script', message: '' };
  let fn: (row: unknown) => unknown;
  try {
    fn = compileColumnScript(src);
  } catch (err) {
    return { ok: false, label: 'compile error', message: errorMessage(err) };
  }
  try {
    return { ok: true, value: fn(row) };
  } catch (err) {
    return { ok: false, label: 'runtime error', message: errorMessage(err) };
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
