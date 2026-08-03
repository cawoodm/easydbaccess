import { describe, expect, it, vi } from 'vitest';
import type { HostApi, Table, ViewInstance } from '@easydb/shared';
import { fetchGistFileContent, offerPrune } from '../../../packages/renderer/src/plugins/gist-sync.js';

// offerPrune reaches the window manager through a dynamic import; the real module
// registers custom elements and cannot load in this Node environment.
const deleteTable = vi.fn();
vi.mock('../../../packages/renderer/src/window-mgr/table-window-manager.js', () => ({
  deleteTable: (id: string) => deleteTable(id),
}));

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
      {
        content: '{"trunc',
        truncated: true,
        raw_url: 'https://gist.githubusercontent.com/x/raw/y',
      },
      doFetch,
    );
    expect(out).toBe('{"full":true}');
    expect(doFetch).toHaveBeenCalledWith('https://gist.githubusercontent.com/x/raw/y');
  });

  it('throws when truncated but no raw_url is provided', async () => {
    await expect(fetchGistFileContent({ content: 'x', truncated: true }, vi.fn())).rejects.toThrow(
      /raw_url/,
    );
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

describe('offerPrune', () => {
  const WS = 'ws1';

  /** Minimal HostApi: the tables/viewInstances the pull left behind, plus the
   *  two dialog surfaces offerPrune uses. */
  function fakeApi(tables: Array<Partial<Table>>, views: Array<Partial<ViewInstance>>) {
    const removedViews: string[] = [];
    // Parameters declared so the assertions can read back the message argument.
    const confirm = vi.fn(async (_message: string, _title?: string) => true);
    return {
      removedViews,
      confirm,
      api: {
        store: {
          tables: { find: async () => tables as Table[] },
          viewInstances: {
            find: async () => views as ViewInstance[],
            remove: async (id: string) => void removedViews.push(id),
          },
        },
        ui: { dialogs: { confirm, toast: vi.fn() } },
      } as unknown as HostApi,
    };
  }

  const table = (id: string, name: string) => ({ id, name, workspaceId: WS });
  const view = (id: string, name: string) => ({ id, name, workspaceId: WS });

  it('says nothing when the pull carried every local object', async () => {
    const f = fakeApi([table('t1', 'Feed')], [view('v1', 'Cards')]);
    await offerPrune(f.api, WS, {
      tableNames: new Set(['feed']),
      viewInstanceIds: new Set(['v1']),
    });
    expect(f.confirm).not.toHaveBeenCalled();
  });

  it('lists the leftovers and deletes them once confirmed', async () => {
    deleteTable.mockClear();
    const f = fakeApi(
      [table('t1', 'Feed'), table('t2', 'Old')],
      [view('v1', 'Cards'), view('v2', 'Gone')],
    );
    await offerPrune(f.api, WS, {
      tableNames: new Set(['feed']),
      viewInstanceIds: new Set(['v1']),
    });
    const message = f.confirm.mock.calls[0]?.[0] as string;
    expect(message).toContain('Old');
    expect(message).toContain('Gone');
    expect(message).not.toContain('Feed');
    expect(deleteTable).toHaveBeenCalledWith('t2');
    expect(f.removedViews).toEqual(['v2']);
  });

  it('deletes nothing when the user declines', async () => {
    deleteTable.mockClear();
    const f = fakeApi([table('t2', 'Old')], []);
    f.confirm.mockResolvedValue(false);
    await offerPrune(f.api, WS, { tableNames: new Set(), viewInstanceIds: null });
    expect(f.confirm).toHaveBeenCalled();
    expect(deleteTable).not.toHaveBeenCalled();
  });

  it('leaves a kind alone when the pull carried none of it', async () => {
    // A settings-only pull has no tables, and a gist with no marker file has no
    // views: null means "no opinion", not "everything was deleted upstream".
    deleteTable.mockClear();
    const f = fakeApi([table('t1', 'Feed')], [view('v1', 'Cards')]);
    await offerPrune(f.api, WS, { tableNames: null, viewInstanceIds: null });
    expect(f.confirm).not.toHaveBeenCalled();
    expect(deleteTable).not.toHaveBeenCalled();
  });

  it('ignores objects from another workspace', async () => {
    const f = fakeApi(
      [{ id: 't9', name: 'Elsewhere', workspaceId: 'other-ws' }],
      [{ id: 'v9', name: 'Elsewhere view', workspaceId: 'other-ws' }],
    );
    await offerPrune(f.api, WS, { tableNames: new Set(), viewInstanceIds: new Set() });
    expect(f.confirm).not.toHaveBeenCalled();
  });
});
