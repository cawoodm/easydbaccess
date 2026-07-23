import { test, expect } from './fixtures.js';
import { panelDomId } from './helpers.js';

/**
 * Live read-write connect, end-to-end through the real UI: the "Connect
 * Datasette" header button → the connect dialog → a live table backed by the
 * remote instance (routed by the Phase-2a seam to the Phase-2c collection) →
 * an edit that writes back via the JSON write API. All network is mocked with
 * page.route, so this validates the wiring, not a live server.
 */

test.describe('datasette live connect', () => {
  test('connects a table, renders live rows, and writes an edit back via PATCH', async ({
    page,
    workspaceId,
  }) => {
    const updates: Array<{ body: any; auth?: string }> = [];

    await page.route('https://ds.example/**', async (route) => {
      const req = route.request();
      const u = new URL(req.url());
      const json = (body: unknown) =>
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          headers: { 'access-control-allow-origin': '*' },
          body: JSON.stringify(body),
        });

      if (req.method() === 'POST' && u.pathname === '/db/people/1/-/update') {
        updates.push({
          body: JSON.parse(req.postData() || '{}'),
          auth: req.headers()['authorization'],
        });
        return json({ ok: true, rows: [{ id: 1, name: 'Alicia' }] });
      }
      if (u.pathname === '/-/versions.json') return json({ datasette: { version: '1.0a37' } });
      if (u.pathname === '/-/actor.json')
        return json({ ok: true, actor: req.headers()['authorization'] ? { id: 'root' } : null });
      if (u.pathname === '/db/people.json') {
        if (u.search.includes('_extra=primary_keys')) return json({ ok: true, primary_keys: ['id'], rows: [] });
        if (u.search.includes('_extra=columns')) return json({ ok: true, columns: ['id', 'name'], rows: [] });
        return json({ ok: true, next: null, rows: [{ id: 1, name: 'Alice' }, { id: 2, name: 'Bob' }] });
      }
      return route.fulfill({ status: 404, body: '{"ok":false}' });
    });

    // Open the connect dialog from the header button, fill URL + token, connect.
    await page.getByTitle('Connect a live Datasette table').click();
    const dlg = page.locator('datasette-connect-dialog dialog');
    await expect(dlg).toBeVisible();
    await dlg.locator('input[type="text"]').fill('https://ds.example/db/people');
    await dlg.locator('input[type="password"]').fill('dstok_T');
    await dlg.getByRole('button', { name: 'Connect', exact: true }).click();
    await expect(dlg).toBeHidden();

    // A live, writable table is created and its rows come from the remote
    // instance (rowCount 2 proves it routed to the live collection, not an
    // empty local Dexie table).
    await expect
      .poll(() =>
        page.evaluate(async (ws) => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const store = (window as any).__easydb.store;
          const t = (await store.tables.find()).find(
            (x: any) => x.workspaceId === ws && x.source?.type === 'datasette',
          );
          if (!t) return null;
          const rows = await store.rows(t.id).find();
          return { writable: t.source.writable, pks: t.source.config.pks, rowCount: rows.length };
        }, workspaceId),
      )
      .toMatchObject({ writable: true, pks: ['id'], rowCount: 2 });

    const tableId: string = await page.evaluate(async (ws) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const store = (window as any).__easydb.store;
      const t = (await store.tables.find()).find(
        (x: any) => x.workspaceId === ws && x.source?.type === 'datasette',
      );
      return t.id;
    }, workspaceId);

    // The grid panel mounted for the live table.
    await expect(page.locator(`#${panelDomId(tableId)}`)).toBeVisible();

    // Edit row id=1 through the routed store → the live collection writes back.
    const patched = await page.evaluate(async (id) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (window as any).__easydb.store
        .rows(id)
        .patch('1', { data: { id: 1, name: 'Alicia' } });
    }, tableId);
    expect(patched.data).toEqual({ id: 1, name: 'Alicia' });

    // Exactly one PATCH went to /<pk>/-/update, with the PK stripped from the
    // update body and the device-local token on the Authorization header.
    expect(updates).toHaveLength(1);
    expect(updates[0]!.body).toEqual({ update: { name: 'Alicia' }, return: true });
    expect(updates[0]!.auth).toBe('Bearer dstok_T');
  });

  test('a token-less connection is read-only: editing a cell is rejected, no write is sent', async ({
    page,
    workspaceId,
  }) => {
    const writes: string[] = [];
    await page.route('https://ds.example/**', async (route) => {
      const req = route.request();
      const u = new URL(req.url());
      const json = (body: unknown) =>
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          headers: { 'access-control-allow-origin': '*' },
          body: JSON.stringify(body),
        });
      if (req.method() === 'POST') {
        writes.push(u.pathname); // must stay empty — read-only
        return json({ ok: false, error: 'Permission denied' });
      }
      if (u.pathname === '/-/versions.json') return json({ datasette: { version: '1.0a37' } });
      if (u.pathname === '/-/actor.json') return json({ ok: true, actor: null }); // anonymous
      if (u.pathname === '/db/people.json') {
        if (u.search.includes('_extra=primary_keys')) return json({ ok: true, primary_keys: ['id'], rows: [] });
        if (u.search.includes('_extra=columns')) return json({ ok: true, columns: ['id', 'name'], rows: [] });
        return json({ ok: true, next: null, rows: [{ id: 1, name: 'Alice' }, { id: 2, name: 'Bob' }] });
      }
      return route.fulfill({ status: 404, body: '{"ok":false}' });
    });

    // Connect with NO token → read-only.
    await page.getByTitle('Connect a live Datasette table').click();
    const dlg = page.locator('datasette-connect-dialog dialog');
    await dlg.locator('input[type="text"]').fill('https://ds.example/db/people');
    await dlg.getByRole('button', { name: 'Connect', exact: true }).click();
    await expect(dlg).toBeHidden();

    await expect
      .poll(() =>
        page.evaluate(async (ws) => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const ts = await (window as any).__easydb.store.tables.find();
          return ts.some((x: any) => x.workspaceId === ws && x.source?.type === 'datasette');
        }, workspaceId),
      )
      .toBe(true);
    const tableId: string = await page.evaluate(async (ws) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ts = await (window as any).__easydb.store.tables.find();
      return ts.find((x: any) => x.workspaceId === ws && x.source?.type === 'datasette').id;
    }, workspaceId);

    // The table opened read-only.
    const writable = await page.evaluate(async (id) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const t = await (window as any).__easydb.store.tables.findOne(id);
      return t.source.writable;
    }, tableId);
    expect(writable).toBe(false);

    // Edit a text cell (the "name" column) and blur → the grid tries to save,
    // the read-only collection rejects, and the grid surfaces "Save failed".
    const nameCell = page.locator(`#${panelDomId(tableId)} input[type="text"]`).first();
    await nameCell.waitFor();
    await nameCell.fill('Zed');
    await nameCell.press('Tab');

    await expect(page.locator('host-dialogs').getByText(/read-only/i)).toBeVisible();
    expect(writes).toEqual([]); // no write request was attempted
  });
});
