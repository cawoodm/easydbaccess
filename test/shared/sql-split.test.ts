import { describe, expect, it } from 'vitest';
import { splitStatements } from '../../packages/shared/src/sql-split.js';

/**
 * The lexer that stops a console from running only the first of three pasted
 * statements. What matters is which `;` ends a statement and which is just a
 * character inside something else.
 */

const sqlOf = (script: string) => splitStatements(script).map((s) => s.sql);

describe('splitStatements', () => {
  it('splits on top-level semicolons', () => {
    expect(sqlOf('SELECT 1; SELECT 2')).toEqual(['SELECT 1', 'SELECT 2']);
  });

  it('returns a lone statement with no semicolon at all', () => {
    expect(sqlOf('SELECT 1')).toEqual(['SELECT 1']);
  });

  it('drops empty statements so the caller can run everything it gets', () => {
    expect(sqlOf('SELECT 1;;  ; SELECT 2;')).toEqual(['SELECT 1', 'SELECT 2']);
    expect(sqlOf('   ')).toEqual([]);
    expect(sqlOf('')).toEqual([]);
  });

  it('keeps a semicolon inside a string literal', () => {
    expect(sqlOf(`SELECT ';'; SELECT 2`)).toEqual([`SELECT ';'`, 'SELECT 2']);
  });

  it("reads '' as an escaped quote, not the end of the literal", () => {
    expect(sqlOf(`SELECT 'it''s; fine'; SELECT 2`)).toEqual([`SELECT 'it''s; fine'`, 'SELECT 2']);
  });

  it('keeps a semicolon inside every identifier quoting SQLite accepts', () => {
    expect(sqlOf('SELECT "a;b" FROM t; SELECT 2')).toEqual(['SELECT "a;b" FROM t', 'SELECT 2']);
    expect(sqlOf('SELECT `a;b` FROM t; SELECT 2')).toEqual(['SELECT `a;b` FROM t', 'SELECT 2']);
    expect(sqlOf('SELECT [a;b] FROM t; SELECT 2')).toEqual(['SELECT [a;b] FROM t', 'SELECT 2']);
  });

  it('ignores a semicolon in a line comment, and the comment ends at the newline', () => {
    expect(sqlOf('SELECT 1 -- one; two\n; SELECT 2')).toEqual(['SELECT 1 -- one; two', 'SELECT 2']);
  });

  it('ignores a semicolon in a block comment', () => {
    expect(sqlOf('SELECT /* a; b */ 1; SELECT 2')).toEqual(['SELECT /* a; b */ 1', 'SELECT 2']);
  });

  it('drops a comment-only tail rather than returning a blank statement', () => {
    expect(sqlOf('SELECT 1;\n-- nothing after this')).toEqual(['SELECT 1']);
  });

  it('does not hang on an unterminated string or comment', () => {
    expect(sqlOf(`SELECT 'oops`)).toEqual([`SELECT 'oops`]);
    expect(sqlOf('SELECT /* oops')).toEqual(['SELECT /* oops']);
  });

  it('reports each statement offset so an error can point at the right place', () => {
    const script = 'SELECT 1;\n  SELECT 2;';
    const parts = splitStatements(script);
    expect(parts.map((p) => p.offset)).toEqual([0, 12]);
    expect(script.slice(parts[1]!.offset, parts[1]!.offset + 8)).toBe('SELECT 2');
  });
});
