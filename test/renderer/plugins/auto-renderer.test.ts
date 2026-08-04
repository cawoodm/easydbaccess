import { describe, expect, it } from 'vitest';
import type { ColumnSpec } from '@easydb/shared';
import { inferRenderer, withInferredRenderers } from '../../../packages/renderer/src/plugins/auto-renderer.js';

describe('inferRenderer', () => {
  it('picks link for http(s) URLs', () => {
    expect(inferRenderer('string', ['https://example.com/a', 'http://example.com/b'])).toBe('link');
  });

  it('picks image for image URLs and data: URIs, in preference to link', () => {
    expect(inferRenderer('string', ['https://x.test/a.png', 'https://x.test/b.JPG?v=2'])).toBe(
      'image',
    );
    expect(inferRenderer('string', ['data:image/png;base64,AAAA'])).toBe('image');
  });

  it('picks preview for markup', () => {
    expect(inferRenderer('string', ['plain', '<p>hello <b>there</b></p>'])).toBe('preview');
    expect(inferRenderer('string', ['<br/>'])).toBe('preview');
  });

  it('picks preview for long prose, by average length', () => {
    const long = 'x'.repeat(200);
    expect(inferRenderer('string', [long, long])).toBe('preview');
    // One long value among short ones does not make the column prose.
    expect(inferRenderer('string', [long, 'a', 'b', 'c', 'd', 'e', 'f', 'g'])).toBeUndefined();
  });

  it('does not mistake a comparison or an unclosed angle bracket for markup', () => {
    expect(inferRenderer('string', ['3 < 4', 'a > b', 'x <- y'])).toBeUndefined();
  });

  it('leaves a mixed column as plain text rather than guessing', () => {
    expect(inferRenderer('string', ['https://example.com/a', 'not a url'])).toBeUndefined();
    // Images fall back to link when only some are images — they are all URLs.
    expect(inferRenderer('string', ['https://x.test/a.png', 'https://x.test/page'])).toBe('link');
  });

  it('ignores blanks, and returns nothing when every value is blank', () => {
    expect(inferRenderer('string', ['', '   ', null, undefined])).toBeUndefined();
    expect(inferRenderer('string', ['', 'https://example.com/a'])).toBe('link');
  });

  it('leaves non-string columns to the importer type inference', () => {
    // date/datetime/boolean already get their renderer from the type; a number
    // needs none. Values are irrelevant here.
    expect(inferRenderer('date', ['2026-01-01'])).toBeUndefined();
    expect(inferRenderer('boolean', [true])).toBeUndefined();
    expect(inferRenderer('number', [1, 2])).toBeUndefined();
  });

  it('gives an array column the tags renderer, whatever its values look like', () => {
    // No sampling: an array cell holds a list by definition, so the pills fit.
    expect(inferRenderer('array', ['foo,bar'])).toBe('tags');
    expect(inferRenderer('array', ['["a","b"]'])).toBe('tags');
    expect(inferRenderer('array', [])).toBe('tags');
  });

  it('stringifies non-string values before testing them', () => {
    expect(inferRenderer('string', [{ toString: () => 'https://example.com/a' }])).toBe('link');
  });
});

describe('withInferredRenderers', () => {
  const rows = [
    { url: 'https://example.com/a', note: 'short', pic: 'https://x.test/a.png' },
    { url: 'https://example.com/b', note: 'also short', pic: 'https://x.test/b.png' },
  ];
  const cols: ColumnSpec[] = [
    { field: 'url', label: 'Url', type: 'string' },
    { field: 'note', label: 'Note', type: 'string' },
    { field: 'pic', label: 'Pic', type: 'string' },
  ];

  it('fills in a renderer per column from the rows', () => {
    expect(withInferredRenderers(cols, rows).map((c) => c.renderer)).toEqual([
      'link',
      undefined,
      'image',
    ]);
  });

  it('never overrides a renderer that is already set', () => {
    const pinned: ColumnSpec[] = [{ ...cols[0]!, renderer: 'html' }];
    expect(withInferredRenderers(pinned, rows)[0]?.renderer).toBe('html');
  });

  it('is idempotent', () => {
    const once = withInferredRenderers(cols, rows);
    expect(withInferredRenderers(once, rows)).toEqual(once);
  });

  it('is a no-op with no rows to learn from', () => {
    expect(withInferredRenderers(cols, [])).toEqual(cols);
  });

  it('ignores a column that is absent from the rows', () => {
    const extra: ColumnSpec[] = [...cols, { field: 'ghost', label: 'Ghost', type: 'string' }];
    expect(withInferredRenderers(extra, rows).at(-1)?.renderer).toBeUndefined();
  });
});

describe('inferRenderer — image bytes, not just image URLs', () => {
  // A photo column read out of a database (northwind's Employees.Photo) holds
  // the JPEG itself, as a SQL hex literal.
  const JPEG_HEX = "X'ffd8ffe000104a464946'";

  it('picks image for a column of SQL blob literals', () => {
    expect(inferRenderer('string', [JPEG_HEX, JPEG_HEX])).toBe('image');
  });

  it('leaves a column of ordinary hexadecimal text alone', () => {
    expect(inferRenderer('string', ['deadbeef', 'cafebabe'])).toBeUndefined();
  });

  it('still refuses a non-image URL', () => {
    expect(inferRenderer('string', ['https://example.com/page'])).toBe('link');
  });
});
