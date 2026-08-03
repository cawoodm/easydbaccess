import { describe, expect, it } from 'vitest';
import { cryptoUUID, slugField, slugTable } from '../../../packages/renderer/src/util/ids.js';

describe('slugTable', () => {
  it('lowercases and joins with dashes', () => {
    expect(slugTable('My Table')).toBe('my-table');
  });

  it('keeps underscores and dashes', () => {
    expect(slugTable('a_b-c')).toBe('a_b-c');
  });

  it('collapses punctuation and trims the edges', () => {
    expect(slugTable('  Hello, World!  ')).toBe('hello-world');
  });

  it('falls back to "table" when nothing survives', () => {
    expect(slugTable('!!!')).toBe('table');
    expect(slugTable('')).toBe('table');
  });
});

describe('slugField', () => {
  it('lowercases and joins with underscores', () => {
    expect(slugField('My Column')).toBe('my_column');
  });

  it('turns a dash into an underscore', () => {
    expect(slugField('a-b')).toBe('a_b');
  });

  it('collapses repeated separators', () => {
    expect(slugField('a   b')).toBe('a_b');
  });

  it('falls back to "col" when nothing survives', () => {
    expect(slugField('!!!')).toBe('col');
    expect(slugField('')).toBe('col');
  });
});

describe('the two slugs are not interchangeable', () => {
  // This is why they have separate names. Before this file they were both
  // called `slug`, which hid the difference and made a wrong import silent.
  it('disagree on the separator', () => {
    expect(slugTable('My Table')).toBe('my-table');
    expect(slugField('My Table')).toBe('my_table');
  });

  it('disagree on the fallback', () => {
    expect(slugTable('###')).toBe('table');
    expect(slugField('###')).toBe('col');
  });
});

describe('cryptoUUID', () => {
  it('returns a non-empty string', () => {
    expect(cryptoUUID().length).toBeGreaterThan(0);
  });

  it('does not repeat', () => {
    const ids = new Set(Array.from({ length: 200 }, () => cryptoUUID()));
    expect(ids.size).toBe(200);
  });
});
