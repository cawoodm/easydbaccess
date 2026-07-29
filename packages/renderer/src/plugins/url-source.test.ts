import { describe, expect, it } from 'vitest';
import type { RowSourceCtx, Table } from '@easydb/shared';
import { createUrlCollection } from './url-source.js';

/**
 * A fake RowSourceCtx whose fetch serves canned text per URL and records the
 * order the URLs were requested in.
 */
function makeCtx(bodies: Record<string, string>) {
  const calls: string[] = [];
  const ctx = {
    backend: {
      fetch: (url: string) => {
        calls.push(url);
        const body = bodies[url];
        if (body === undefined) {
          return Promise.resolve({ ok: false, status: 404, statusText: 'Not Found' } as Response);
        }
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: { get: () => null },
          text: () => Promise.resolve(body),
        } as unknown as Response);
      },
      saveFile: async () => undefined,
    },
    events: { on: () => () => undefined, emit: () => undefined },
    settings: { findOne: async () => null },
    workspaceId: () => 'ws',
  } as unknown as RowSourceCtx;
  return { ctx, calls };
}

function urlTable(url: string): Table {
  return {
    id: 't1',
    workspaceId: 'ws',
    name: 'remote',
    code: 'remote',
    columns: [],
    view: 'table',
    updatedAt: 0,
    source: { type: 'url', writable: false, config: { url, format: 'csv' } },
  };
}

const POINTER = 'version https://git-lfs.github.com/spec/v1\noid sha256:2d1f6530\nsize 140893245\n';
const CSV = 'name,city\nada,zurich\n';

const BLOB = 'https://github.com/o/r/blob/main/data.csv';
const RAW = 'https://raw.githubusercontent.com/o/r/main/data.csv';
const MEDIA = 'https://media.githubusercontent.com/media/o/r/main/data.csv';

describe('createUrlCollection — GitHub URL handling', () => {
  it('rewrites a github.com blob URL to the CORS-friendly raw host', async () => {
    const { ctx, calls } = makeCtx({ [RAW]: CSV });
    const rows = await createUrlCollection(urlTable(BLOB), ctx).find();
    expect(calls).toEqual([RAW]);
    expect(rows.map((r) => r.data)).toEqual([{ name: 'ada', city: 'zurich' }]);
  });

  it('follows an LFS pointer to the media host instead of importing the stub', async () => {
    const { ctx, calls } = makeCtx({ [RAW]: POINTER, [MEDIA]: CSV });
    const rows = await createUrlCollection(urlTable(BLOB), ctx).find();
    expect(calls).toEqual([RAW, MEDIA]);
    // Without the follow-up this was one row of pointer text, not the data.
    expect(rows.map((r) => r.data)).toEqual([{ name: 'ada', city: 'zurich' }]);
  });

  it('does not reach for the media host when the raw body is real content', async () => {
    const { ctx, calls } = makeCtx({ [RAW]: CSV });
    await createUrlCollection(urlTable(RAW), ctx).find();
    expect(calls).toEqual([RAW]);
  });

  it('leaves a non-GitHub URL alone', async () => {
    const other = 'https://example.com/data.csv';
    const { ctx, calls } = makeCtx({ [other]: CSV });
    await createUrlCollection(urlTable(other), ctx).find();
    expect(calls).toEqual([other]);
  });
});
