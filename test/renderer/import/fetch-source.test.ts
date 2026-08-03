import { describe, expect, it, vi } from 'vitest';
import type { HostApi } from '@easydb/shared';
import { fetchImportText, MAX_IMPORT_BYTES } from '../../../packages/renderer/src/import/fetch-source.js';

interface Canned {
  body: string;
  /** Advertised Content-Length; defaults to the body length. */
  length?: number;
}

/**
 * A fake HostApi serving canned bodies per URL. Each response records whether
 * its body stream was cancelled, so a rejected oversize read can be checked for
 * abandoning the transfer instead of letting it run on.
 */
function makeApi(bodies: Record<string, Canned>) {
  const calls: string[] = [];
  const cancelled: string[] = [];
  const api = {
    backend: {
      fetch: (url: string) => {
        calls.push(url);
        const canned = bodies[url];
        if (!canned) {
          return Promise.resolve({
            ok: false,
            status: 404,
            statusText: 'Not Found',
            text: () => Promise.resolve('nope'),
          } as unknown as Response);
        }
        const len = canned.length ?? canned.body.length;
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: { get: (h: string) => (h === 'content-length' ? String(len) : null) },
          body: {
            cancel: () => {
              cancelled.push(url);
              return Promise.resolve();
            },
          },
          text: () => Promise.resolve(canned.body),
        } as unknown as Response);
      },
    },
  } as unknown as HostApi;
  return { api, calls, cancelled };
}

const POINTER = 'version https://git-lfs.github.com/spec/v1\noid sha256:2d1f6530\nsize 140893245\n';
const CSV = 'name,city\nada,zurich\n';

const BLOB = 'https://github.com/o/r/blob/main/data.csv';
const RAW = 'https://raw.githubusercontent.com/o/r/main/data.csv';
const MEDIA = 'https://media.githubusercontent.com/media/o/r/main/data.csv';

describe('fetchImportText — GitHub URLs', () => {
  it('rewrites a blob URL to the raw host and returns its text', async () => {
    const { api, calls } = makeApi({ [RAW]: { body: CSV } });
    expect(await fetchImportText(api, BLOB)).toBe(CSV);
    expect(calls).toEqual([RAW]);
  });

  it('follows an LFS pointer to the media host', async () => {
    const { api, calls } = makeApi({ [RAW]: { body: POINTER }, [MEDIA]: { body: CSV } });
    expect(await fetchImportText(api, BLOB)).toBe(CSV);
    expect(calls).toEqual([RAW, MEDIA]);
  });

  it('keeps the pointer text when the media host has no such file', async () => {
    // Not every 200-with-pointer-looking-body is LFS-backed; a 404 on the media
    // host must surface as an error rather than silently importing the stub.
    const { api } = makeApi({ [RAW]: { body: POINTER } });
    await expect(fetchImportText(api, BLOB)).rejects.toThrow(/HTTP 404/);
  });
});

describe('fetchImportText — size limit', () => {
  it('refuses an oversized response with its real size', async () => {
    const { api } = makeApi({ [RAW]: { body: CSV, length: MAX_IMPORT_BYTES + 1 } });
    await expect(fetchImportText(api, RAW)).rejects.toThrow(/over the 50 MB browser import limit/);
  });

  it('cancels the body of an oversized response so it stops downloading', async () => {
    const { api, cancelled } = makeApi({ [RAW]: { body: CSV, length: 140_893_245 } });
    await expect(fetchImportText(api, RAW)).rejects.toThrow();
    expect(cancelled).toEqual([RAW]);
  });

  it('applies the limit to the media host too, not just the first read', async () => {
    const { api, calls, cancelled } = makeApi({
      [RAW]: { body: POINTER },
      [MEDIA]: { body: CSV, length: 140_893_245 },
    });
    // 140_893_245 bytes reported as MiB — the real size of the GitHub LFS file
    // that made this path reachable.
    await expect(fetchImportText(api, BLOB)).rejects.toThrow(/134\.4 MB/);
    expect(calls).toEqual([RAW, MEDIA]);
    expect(cancelled).toEqual([MEDIA]);
  });
});

describe('fetchImportText — failures', () => {
  it('reports an unreachable host rather than a bare fetch error', async () => {
    const api = {
      backend: { fetch: vi.fn().mockRejectedValue(new Error('Load failed')) },
    } as unknown as HostApi;
    await expect(fetchImportText(api, 'https://example.com/x.csv')).rejects.toThrow(
      /Could not reach example\.com — no response/,
    );
  });
});
