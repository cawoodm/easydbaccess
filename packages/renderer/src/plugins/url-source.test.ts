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

function urlTable(url: string, format: 'csv' | 'json' = 'csv'): Table {
  return {
    id: 't1',
    workspaceId: 'ws',
    name: 'remote',
    code: 'remote',
    columns: [],
    view: 'table',
    updatedAt: 0,
    source: { type: 'url', writable: false, config: { url, format } },
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

/**
 * A referenced Datasette table is capped by the instance's `max_returned_rows`
 * (1000 by default) whatever `_size` we ask for, so reading a single page
 * silently truncated every reference. The provider now follows the paging
 * cursor Datasette hands back in `next_url`.
 */
describe('createUrlCollection — paged JSON', () => {
  const P1 = 'https://ds.test/db/t.json?_size=max';
  const P2 = 'https://ds.test/db/t.json?_size=max&_next=100';

  const page = (rows: Array<Record<string, unknown>>, next?: string) =>
    JSON.stringify({ ok: true, rows, ...(next ? { next: '100', next_url: next } : {}) });

  it('follows next_url until the cursor runs out', async () => {
    const { ctx, calls } = makeCtx({
      [P1]: page([{ id: 1 }], P2),
      [P2]: page([{ id: 2 }]),
    });
    const rows = await createUrlCollection(urlTable(P1, 'json'), ctx).find();
    expect(calls).toEqual([P1, P2]);
    expect(rows.map((r) => r.data)).toEqual([{ id: 1 }, { id: 2 }]);
  });

  it('stops on a page that returns no rows, even if it still offers a cursor', async () => {
    const { ctx, calls } = makeCtx({
      [P1]: page([{ id: 1 }], P2),
      [P2]: page([], P2),
    });
    await createUrlCollection(urlTable(P1, 'json'), ctx).find();
    expect(calls).toEqual([P1, P2]);
  });

  it('does not loop on a cursor that points at itself', async () => {
    const { ctx, calls } = makeCtx({ [P1]: page([{ id: 1 }], P1) });
    const rows = await createUrlCollection(urlTable(P1, 'json'), ctx).find();
    expect(calls).toEqual([P1]);
    expect(rows).toHaveLength(1);
  });

  it('spends a bare Datasette cursor token as ?_next=, dropping other _params', async () => {
    // datasette.io sends ONLY a token — no next_url — so ignoring tokens left a
    // reference stuck on page one. `_size` is dropped on purpose: datasette.io's
    // WAF challenges a .json request carrying two or more `_`-prefixed params.
    const tokenPage = 'https://ds.test/db/t.json?_next=111732894';
    const { ctx, calls } = makeCtx({
      [P1]: JSON.stringify({ ok: true, rows: [{ id: 1 }], next: '111732894' }),
      [tokenPage]: JSON.stringify({ ok: true, rows: [{ id: 2 }], next: null }),
    });
    const rows = await createUrlCollection(urlTable(P1, 'json'), ctx).find();
    expect(calls).toEqual([P1, tokenPage]);
    expect(rows.map((r) => r.data)).toEqual([{ id: 1 }, { id: 2 }]);
  });

  it('does not invent a cursor URL for a non-Datasette body with a `next` field', async () => {
    // Without the `{ ok, rows }` envelope a `next` could be anything — a page
    // number, an id, a name. Guessing `?_next=` there would fetch nonsense.
    const { ctx, calls } = makeCtx({
      [P1]: JSON.stringify({ items: [{ id: 1 }], next: '100' }),
    });
    await createUrlCollection(urlTable(P1, 'json'), ctx).find();
    expect(calls).toEqual([P1]);
  });

  it('ignores a cursor pointing at another origin', async () => {
    // No token in this body, so the cross-origin next_url is the only cursor on
    // offer — and it must not be followed.
    const { ctx, calls } = makeCtx({
      [P1]: JSON.stringify({
        ok: true,
        rows: [{ id: 1 }],
        next_url: 'https://elsewhere.test/steal.json',
      }),
    });
    await createUrlCollection(urlTable(P1, 'json'), ctx).find();
    expect(calls).toEqual([P1]);
  });

  it('resolves a relative cursor against the page URL', async () => {
    const rel = 'https://ds.test/db/t.json?_next=100';
    const { ctx, calls } = makeCtx({
      [P1]: page([{ id: 1 }], '/db/t.json?_next=100'),
      [rel]: page([{ id: 2 }]),
    });
    await createUrlCollection(urlTable(P1, 'json'), ctx).find();
    expect(calls).toEqual([P1, rel]);
  });

  it('never pages a CSV reference — there is no cursor in a CSV', async () => {
    const { ctx, calls } = makeCtx({ [P1]: CSV });
    await createUrlCollection(urlTable(P1, 'csv'), ctx).find();
    expect(calls).toEqual([P1]);
  });
});
