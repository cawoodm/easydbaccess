import { describe, expect, it, vi } from 'vitest';
import { fetchGistFileContent } from './gist-sync.js';

describe('fetchGistFileContent', () => {
  it('returns inline content when not truncated, without fetching', async () => {
    const doFetch = vi.fn();
    const out = await fetchGistFileContent({ content: '{"a":1}', truncated: false }, doFetch);
    expect(out).toBe('{"a":1}');
    expect(doFetch).not.toHaveBeenCalled();
  });

  it('fetches raw_url when truncated and returns the full body', async () => {
    const doFetch = vi.fn(
      async () => ({ ok: true, text: async () => '{"full":true}' }) as unknown as Response,
    );
    const out = await fetchGistFileContent(
      { content: '{"trunc', truncated: true, raw_url: 'https://gist.githubusercontent.com/x/raw/y' },
      doFetch,
    );
    expect(out).toBe('{"full":true}');
    expect(doFetch).toHaveBeenCalledWith('https://gist.githubusercontent.com/x/raw/y');
  });

  it('throws when truncated but no raw_url is provided', async () => {
    await expect(
      fetchGistFileContent({ content: 'x', truncated: true }, vi.fn()),
    ).rejects.toThrow(/raw_url/);
  });

  it('throws when the raw fetch is not ok', async () => {
    const doFetch = vi.fn(
      async () => ({ ok: false, status: 404, statusText: 'Not Found' }) as unknown as Response,
    );
    await expect(
      fetchGistFileContent({ content: 'x', truncated: true, raw_url: 'https://x/raw' }, doFetch),
    ).rejects.toThrow(/404/);
  });
});
