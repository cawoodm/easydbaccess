import { describe, expect, it } from 'vitest';
import { COLUMN_SCRIPT_HELPERS, compileColumnScript, runColumnScript, runValidateScript } from '../../../packages/renderer/src/util/column-script.js';

describe('runColumnScript', () => {
  it('returns whatever render(row) returns, not just strings', () => {
    expect(runColumnScript('function render(row) { return row.a + row.b }', { a: 2, b: 3 })).toEqual({ ok: true, value: 5 });
    expect(runColumnScript('function render() { return true }', {})).toEqual({
      ok: true,
      value: true,
    });
    // A renderer may legitimately want null/undefined through.
    expect(runColumnScript('function render() { return null }', {})).toEqual({
      ok: true,
      value: null,
    });
  });

  it('reads any field of the row, which is the point of a column script', () => {
    const row = { first: 'Ada', last: 'Lovelace' };
    const run = runColumnScript('function render(row) { return row.first + " " + row.last }', row);
    expect(run).toEqual({ ok: true, value: 'Ada Lovelace' });
  });

  it('allows const declarations and built-ins inside the body', () => {
    const run = runColumnScript('const pad = (n) => String(n).padStart(2, "0");\nfunction render(row) { return pad(row.n) }', { n: 7 });
    expect(run).toEqual({ ok: true, value: '07' });
  });

  it('reports a syntax error as a compile error', () => {
    const run = runColumnScript('function render(row) { return', {});
    expect(run.ok).toBe(false);
    if (!run.ok) expect(run.label).toBe('compile error');
  });

  it('reports a throw as a runtime error, with the message', () => {
    const run = runColumnScript('function render() { throw new Error("boom") }', {});
    expect(run.ok).toBe(false);
    if (!run.ok) {
      expect(run.label).toBe('runtime error');
      expect(run.message).toBe('boom');
    }
  });

  it('reports a missing render() as a runtime error', () => {
    const run = runColumnScript('const x = 1;', {});
    expect(run.ok).toBe(false);
    if (!run.ok) expect(run.label).toBe('runtime error');
  });

  it('treats a blank or absent script as "no script" rather than throwing', () => {
    for (const src of [undefined, '', '   \n']) {
      const run = runColumnScript(src, {});
      expect(run.ok).toBe(false);
      if (!run.ok) expect(run.label).toBe('no script');
    }
  });
});

describe('compileColumnScript', () => {
  it('memoizes by source, so a big table compiles once per column', () => {
    const src = 'function render(row) { return row.a }';
    expect(compileColumnScript(src)).toBe(compileColumnScript(src));
    expect(compileColumnScript(src)).not.toBe(compileColumnScript('function render(row) { return row.b }'));
  });

  it('throws on a syntax error (runColumnScript is what catches it)', () => {
    expect(() => compileColumnScript('function render( {')).toThrow();
  });
});

describe('script helpers', () => {
  it('exposes markdownToHtml by name, so a script can call it directly', () => {
    const run = runColumnScript('function render(row) { return markdownToHtml(row.notes) }', {
      notes: '**bold**',
    });
    expect(run.ok).toBe(true);
    if (run.ok) expect(run.value).toBe('<p><strong>bold</strong></p>');
  });

  it('exposes the same helpers under an `easydb` namespace', () => {
    const run = runColumnScript('function render(row) { return easydb.markdownToHtml("# h") }', {});
    expect(run.ok).toBe(true);
    if (run.ok) expect(run.value).toBe('<h1>h</h1>');
  });

  it('lists what it injects, so the editor hint cannot drift from the truth', () => {
    expect(COLUMN_SCRIPT_HELPERS).toContain('markdownToHtml');
  });

  it('leaves a script that shadows a helper name working on its own version', () => {
    // The helpers are parameters, so a local declaration wins — a script that
    // defined its own `markdownToHtml` before must not break.
    const run = runColumnScript('function markdownToHtml(s) { return "mine:" + s }\nfunction render(row) { return markdownToHtml("x") }', {});
    expect(run.ok).toBe(true);
    if (run.ok) expect(run.value).toBe('mine:x');
  });
});

describe('runValidateScript', () => {
  const RULE = `function validate(value, row) {
    if (!value) throw new Error('Required.');
    if (row.max != null && value > row.max) throw new Error('Over the row max.');
  }`;

  it('accepts a value the rule does not object to', () => {
    expect(runValidateScript(RULE, 5, { max: 10 })).toEqual({ ok: true });
  });

  it('rejects with the thrown message, which is what the user sees', () => {
    expect(runValidateScript(RULE, 50, { max: 10 })).toEqual({ ok: false, message: 'Over the row max.' });
  });

  it('treats a blank or missing script as nothing to check', () => {
    expect(runValidateScript(undefined, 1, {})).toEqual({ ok: true });
    expect(runValidateScript('   \n', 1, {})).toEqual({ ok: true });
  });

  it('labels a syntax error as a compile error, so the author can tell it apart from a rejection', () => {
    const out = runValidateScript('function validate(value, row) { if (', 1, {});
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.message).toMatch(/compile error/);
  });

  it('reports a script that defines no validate() rather than accepting silently', () => {
    const out = runValidateScript('const x = 1;', 'anything', {});
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.message).toMatch(/validate is not defined/);
  });

  it('accepts a bare `throw "text"` as a rejection', () => {
    const out = runValidateScript('function validate(v) { throw "no good" }', 1, {});
    expect(out).toEqual({ ok: false, message: 'no good' });
  });

  it('falls back to a message when something throws with no text at all', () => {
    const out = runValidateScript('function validate(v) { throw new Error() }', 1, {});
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.message).toMatch(/validation script/i);
  });

  it('gives a validator the same helpers a render script gets', () => {
    const out = runValidateScript('function validate(v) { if (typeof easydb.markdownToHtml !== "function") throw new Error("missing") }', 1, {});
    expect(out).toEqual({ ok: true });
  });

  it('compiles the same source separately from a render script of that source', () => {
    // Both caches key on the raw string. A source that happens to define BOTH
    // functions must work either way round — the compiled wrappers differ in
    // their parameter list, so a shared cache would hand back the wrong one.
    const both = 'function render(row) { return row.a } function validate(value, row) { if (value === row.a) throw new Error("same") }';
    expect(runColumnScript(both, { a: 7 })).toEqual({ ok: true, value: 7 });
    expect(runValidateScript(both, 7, { a: 7 })).toEqual({ ok: false, message: 'same' });
    expect(runColumnScript(both, { a: 7 })).toEqual({ ok: true, value: 7 });
  });
});
