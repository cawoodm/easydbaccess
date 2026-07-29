import { describe, expect, it } from 'vitest';
import { compileColumnScript, runColumnScript } from './column-script.js';

describe('runColumnScript', () => {
  it('returns whatever render(row) returns, not just strings', () => {
    expect(
      runColumnScript('function render(row) { return row.a + row.b }', { a: 2, b: 3 }),
    ).toEqual({ ok: true, value: 5 });
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
    const run = runColumnScript(
      'const pad = (n) => String(n).padStart(2, "0");\nfunction render(row) { return pad(row.n) }',
      { n: 7 },
    );
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
    expect(compileColumnScript(src)).not.toBe(
      compileColumnScript('function render(row) { return row.b }'),
    );
  });

  it('throws on a syntax error (runColumnScript is what catches it)', () => {
    expect(() => compileColumnScript('function render( {')).toThrow();
  });
});
