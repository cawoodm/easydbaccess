import { describe, expect, it, vi } from 'vitest';
import { readResponseText, toCorsFriendlyUrl } from './read-url.js';

/** A Response double that streams `text` in the given chunk sizes with a
 *  Content-Length header, so readResponseText takes its progress path. */
function streamRes(text: string, chunkSizes: number[]): Response {
  const bytes = new TextEncoder().encode(text);
  let ci = 0;
  let pos = 0;
  const reader = {
    read: () => {
      if (pos >= bytes.length) return Promise.resolve({ done: true, value: undefined });
      const size = chunkSizes[ci++] ?? bytes.length - pos;
      const value = bytes.slice(pos, pos + size);
      pos += size;
      return Promise.resolve({ done: false, value });
    },
  };
  return {
    headers: {
      get: (k: string) => (k.toLowerCase() === 'content-length' ? String(bytes.length) : null),
    },
    body: { getReader: () => reader },
  } as unknown as Response;
}

/** A Response double with no streaming body — forces the res.text() fallback. */
function textRes(text: string): Response {
  return {
    headers: { get: () => null },
    text: () => Promise.resolve(text),
  } as unknown as Response;
}

describe('readResponseText', () => {
  it('streams the body and reports increasing progress to 1 when the size is known', async () => {
    const fractions: number[] = [];
    const text = await readResponseText(streamRes('hello world', [4, 4, 3]), (f) =>
      fractions.push(f),
    );
    expect(text).toBe('hello world');
    // Monotonic, ending exactly at 1, one report per chunk.
    expect(fractions).toEqual([...fractions].sort((a, b) => a - b));
    expect(fractions.at(-1)).toBe(1);
    expect(fractions.length).toBe(3);
  });

  it('falls back to res.text() (no progress) when there is no streamable body', async () => {
    const onProgress = vi.fn();
    const text = await readResponseText(textRes('{"a":1}'), onProgress);
    expect(text).toBe('{"a":1}');
    expect(onProgress).not.toHaveBeenCalled();
  });

  it('works without an onProgress callback', async () => {
    expect(await readResponseText(streamRes('abcdef', [3, 3]))).toBe('abcdef');
  });
});

describe('toCorsFriendlyUrl', () => {
  it('rewrites a github.com /raw/refs/heads/ URL to raw.githubusercontent.com', () => {
    expect(
      toCorsFriendlyUrl(
        'https://github.com/StackExchange/Survey/raw/refs/heads/main/packages/archive/2024/results.csv',
      ),
    ).toBe(
      'https://raw.githubusercontent.com/StackExchange/Survey/main/packages/archive/2024/results.csv',
    );
  });

  it('rewrites a github.com /blob/ URL and collapses refs/heads', () => {
    expect(toCorsFriendlyUrl('https://github.com/o/r/blob/refs/heads/dev/data/x.json')).toBe(
      'https://raw.githubusercontent.com/o/r/dev/data/x.json',
    );
  });

  it('handles a plain branch ref (no refs/heads) and nested paths', () => {
    expect(toCorsFriendlyUrl('https://github.com/o/r/raw/main/a/b/c.csv')).toBe(
      'https://raw.githubusercontent.com/o/r/main/a/b/c.csv',
    );
  });

  it('collapses refs/tags too', () => {
    expect(toCorsFriendlyUrl('https://github.com/o/r/blob/refs/tags/v1.2/data.csv')).toBe(
      'https://raw.githubusercontent.com/o/r/v1.2/data.csv',
    );
  });

  it('preserves percent-encoded path segments', () => {
    expect(toCorsFriendlyUrl('https://github.com/o/r/raw/main/Air%20Quality/x.csv')).toBe(
      'https://raw.githubusercontent.com/o/r/main/Air%20Quality/x.csv',
    );
  });

  it('leaves already-CORS raw.githubusercontent.com URLs unchanged', () => {
    const u = 'https://raw.githubusercontent.com/o/r/main/x.csv';
    expect(toCorsFriendlyUrl(u)).toBe(u);
  });

  it('leaves non-file github URLs (repo/tree pages) and unknown hosts unchanged', () => {
    const tree = 'https://github.com/o/r/tree/main/dir';
    expect(toCorsFriendlyUrl(tree)).toBe(tree);
    const other = 'https://example.com/data.csv';
    expect(toCorsFriendlyUrl(other)).toBe(other);
    expect(toCorsFriendlyUrl('not a url')).toBe('not a url');
  });
});
