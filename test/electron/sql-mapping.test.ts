import { describe, expect, it } from 'vitest';
import { columnTypeFromSqlType, decodeValue, encodeValue, quoteIdent, sanitizeTableName, sqlAffinity } from '@easydb/shared';

/**
 * Unit tests for the SQL-mapping helpers shared between
 * `packages/server/src/storage/sqlite-store.ts` and
 * `packages/electron/src/sqlite-store.ts`. Lives here (not in
 * `packages/shared`) because that package has no test runner configured —
 * see the 2026-07-31 electron-sqlite-storage plan.
 */

describe('quoteIdent', () => {
  it('wraps an identifier in double quotes', () => {
    expect(quoteIdent('people')).toBe('"people"');
  });

  it('escapes embedded double quotes by doubling them', () => {
    expect(quoteIdent('weird"name')).toBe('"weird""name"');
  });
});

describe('sanitizeTableName', () => {
  it('leaves an already-safe name untouched', () => {
    expect(sanitizeTableName('people')).toBe('people');
  });

  it('replaces any non [A-Za-z0-9_] character with an underscore', () => {
    expect(sanitizeTableName('simon-blog/entries')).toBe('simon_blog_entries');
  });

  it('replaces multiple different unsafe characters', () => {
    expect(sanitizeTableName('a b.c!d')).toBe('a_b_c_d');
  });
});

describe('sqlAffinity', () => {
  it('maps number to REAL', () => {
    expect(sqlAffinity('number')).toBe('REAL');
  });

  it('maps boolean to INTEGER', () => {
    expect(sqlAffinity('boolean')).toBe('INTEGER');
  });

  it('maps string, date and datetime to TEXT', () => {
    expect(sqlAffinity('string')).toBe('TEXT');
    expect(sqlAffinity('date')).toBe('TEXT');
    expect(sqlAffinity('datetime')).toBe('TEXT');
  });
});

describe('encodeValue', () => {
  it('encodes null/undefined as null regardless of type', () => {
    expect(encodeValue('string', null)).toBeNull();
    expect(encodeValue('number', undefined)).toBeNull();
    expect(encodeValue('boolean', null)).toBeNull();
  });

  it('encodes boolean as 1/0', () => {
    expect(encodeValue('boolean', true)).toBe(1);
    expect(encodeValue('boolean', false)).toBe(0);
    // truthy/falsy coercion, not just literal booleans
    expect(encodeValue('boolean', 1)).toBe(1);
    expect(encodeValue('boolean', '')).toBe(0);
  });

  it('encodes number, coercing non-numeric strings to null', () => {
    expect(encodeValue('number', 42)).toBe(42);
    expect(encodeValue('number', '42')).toBe(42);
    expect(encodeValue('number', 'not-a-number')).toBeNull();
  });

  it('encodes everything else (string/date/datetime) via String()', () => {
    expect(encodeValue('string', 'hello')).toBe('hello');
    expect(encodeValue('string', 42)).toBe('42');
    expect(encodeValue('date', '2026-01-01')).toBe('2026-01-01');
  });
});

describe('decodeValue', () => {
  it('decodes null/undefined as null regardless of type', () => {
    expect(decodeValue('string', null)).toBeNull();
    expect(decodeValue('number', undefined)).toBeNull();
  });

  it('decodes boolean via double negation', () => {
    expect(decodeValue('boolean', 1)).toBe(true);
    expect(decodeValue('boolean', 0)).toBe(false);
  });

  it('passes through everything else unchanged', () => {
    expect(decodeValue('string', 'hello')).toBe('hello');
    expect(decodeValue('number', 42)).toBe(42);
  });
});

describe('columnTypeFromSqlType — inverse of sqlAffinity, for importing a foreign SQLite file', () => {
  it('maps INTEGER-family declared types to number (SQLite rule 1: contains "INT")', () => {
    expect(columnTypeFromSqlType('INTEGER')).toBe('number');
    expect(columnTypeFromSqlType('INT')).toBe('number');
    expect(columnTypeFromSqlType('BIGINT')).toBe('number');
    expect(columnTypeFromSqlType('UNSIGNED BIG INT')).toBe('number');
  });

  it('maps CHAR/CLOB/TEXT-family declared types to string (rule 2)', () => {
    expect(columnTypeFromSqlType('TEXT')).toBe('string');
    expect(columnTypeFromSqlType('VARCHAR(255)')).toBe('string');
    expect(columnTypeFromSqlType('NCHAR(10)')).toBe('string');
    expect(columnTypeFromSqlType('CLOB')).toBe('string');
  });

  it('maps BLOB and no declared type to string (rule 3 — no ColumnType for blob)', () => {
    expect(columnTypeFromSqlType('BLOB')).toBe('string');
    expect(columnTypeFromSqlType('')).toBe('string');
    expect(columnTypeFromSqlType(null)).toBe('string');
    expect(columnTypeFromSqlType(undefined)).toBe('string');
  });

  it('maps REAL/FLOA/DOUB-family declared types to number (rule 4)', () => {
    expect(columnTypeFromSqlType('REAL')).toBe('number');
    expect(columnTypeFromSqlType('DOUBLE')).toBe('number');
    expect(columnTypeFromSqlType('DOUBLE PRECISION')).toBe('number');
    expect(columnTypeFromSqlType('FLOAT')).toBe('number');
  });

  it('maps NUMERIC/DECIMAL/unrecognized declared types to number (rule 5 — the catch-all)', () => {
    expect(columnTypeFromSqlType('NUMERIC')).toBe('number');
    expect(columnTypeFromSqlType('DECIMAL(10,2)')).toBe('number');
    expect(columnTypeFromSqlType('SOME_MADE_UP_TYPE')).toBe('number');
  });

  it('special-cases BOOL-containing types to boolean, ahead of the INT rule', () => {
    expect(columnTypeFromSqlType('BOOLEAN')).toBe('boolean');
    expect(columnTypeFromSqlType('BOOL')).toBe('boolean');
  });

  it('special-cases DATE/TIME-containing types to date/datetime, ahead of the INT rule', () => {
    expect(columnTypeFromSqlType('DATE')).toBe('date');
    expect(columnTypeFromSqlType('DATETIME')).toBe('datetime');
    expect(columnTypeFromSqlType('TIMESTAMP')).toBe('datetime');
    expect(columnTypeFromSqlType('TIME')).toBe('datetime');
  });

  it('is case-insensitive', () => {
    expect(columnTypeFromSqlType('integer')).toBe('number');
    expect(columnTypeFromSqlType('varchar(20)')).toBe('string');
  });
});
