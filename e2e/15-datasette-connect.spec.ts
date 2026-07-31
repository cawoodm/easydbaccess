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
        if (u.search.includes('_extra=primary_keys'))
          return json({ ok: true, primary_keys: ['id'], rows: [] });
        if (u.search.includes('_extra=columns'))
          return json({ ok: true, columns: ['id', 'name'], rows: [] });
        return json({
          ok: true,
          next: null,
          rows: [
            { id: 1, name: 'Alice' },
            { id: 2, name: 'Bob' },
          ],
        });
      }
      return route.fulfill({ status: 404, body: '{"ok":false}' });
    });

    // Open the connect dialog from the header button, fill URL + token, connect.
    await page.getByTitle(/Connect a live/).click();
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

    // …and the grid actually RENDERS the two live rows. (Regression guard: a
    // source-backed table must route to the live collection the instant its
    // panel binds `rows(id)`; if the routing cache is cold it silently reads
    // the empty local table — columns show, no rows.)
    await expect(
      page.locator(`#${panelDomId(tableId)}`).locator('tbody tr:not(.spacer)'),
    ).toHaveCount(2);

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
        if (u.search.includes('_extra=primary_keys'))
          return json({ ok: true, primary_keys: ['id'], rows: [] });
        if (u.search.includes('_extra=columns'))
          return json({ ok: true, columns: ['id', 'name'], rows: [] });
        return json({
          ok: true,
          next: null,
          rows: [
            { id: 1, name: 'Alice' },
            { id: 2, name: 'Bob' },
          ],
        });
      }
      return route.fulfill({ status: 404, body: '{"ok":false}' });
    });

    // Connect with NO token → read-only.
    await page.getByTitle(/Connect a live/).click();
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

  test('deleting a live table removes it locally, writes nothing remote, and it does not reappear', async ({
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
        writes.push(u.pathname); // must stay empty — closing must not write to the remote
        return json({ ok: false, error: 'Permission denied' });
      }
      if (u.pathname === '/-/versions.json') return json({ datasette: { version: '1.0a37' } });
      if (u.pathname === '/-/actor.json') return json({ ok: true, actor: null });
      if (u.pathname === '/db/people.json') {
        if (u.search.includes('_extra=primary_keys'))
          return json({ ok: true, primary_keys: ['id'], rows: [] });
        if (u.search.includes('_extra=columns'))
          return json({ ok: true, columns: ['id', 'name'], rows: [] });
        return json({
          ok: true,
          next: null,
          rows: [
            { id: 1, name: 'Alice' },
            { id: 2, name: 'Bob' },
          ],
        });
      }
      return route.fulfill({ status: 404, body: '{"ok":false}' });
    });

    // Connect token-less (read-only) and grab the live table's id.
    await page.getByTitle(/Connect a live/).click();
    const dlg = page.locator('datasette-connect-dialog dialog');
    await dlg.locator('input[type="text"]').fill('https://ds.example/db/people');
    await dlg.getByRole('button', { name: 'Connect', exact: true }).click();
    await expect(dlg).toBeHidden();

    const tableId: string = await (async () => {
      await expect
        .poll(() =>
          page.evaluate(async (ws) => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const ts = await (window as any).__easydb.store.tables.find();
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            return ts.some((x: any) => x.workspaceId === ws && x.source?.type === 'datasette');
          }, workspaceId),
        )
        .toBe(true);
      return page.evaluate(async (ws) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const ts = await (window as any).__easydb.store.tables.find();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return ts.find((x: any) => x.workspaceId === ws && x.source?.type === 'datasette').id;
      }, workspaceId);
    })();

    await page.locator(`#${panelDomId(tableId)}`).waitFor();

    // Closing a window only HIDES a table now (v0.0.139), for a live table as
    // much as a local one — permanent removal is the footer's trash button, and
    // that is the path this test is about: it must drop the local record without
    // ever writing to the remote.
    await page.locator(`#${panelDomId(tableId)} panel-footer`).getByTitle(/Delete this table/).click();
    await page.locator('host-dialogs').getByRole('button', { name: 'Yes' }).click();

    // The local Table record is removed (the bug left it behind because the
    // row-cascade routed to the read-only remote and threw before tables.remove).
    await expect
      .poll(() =>
        page.evaluate(async (id) => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          return (await (window as any).__easydb.store.tables.findOne(id)) == null;
        }, tableId),
      )
      .toBe(true);

    // The panel is gone and stays gone (no subscription-driven reappearance).
    await expect(page.locator(`#${panelDomId(tableId)}`)).toHaveCount(0);
    // Deleting must never issue a remote write (no row DELETEs on the server).
    expect(writes).toEqual([]);
  });

  test('a connected live table has a Refresh button that re-pulls remote rows', async ({
    page,
    workspaceId,
  }) => {
    let people = [
      { id: 1, name: 'Alice' },
      { id: 2, name: 'Bob' },
    ];
    await page.route('https://ds.example/**', async (route) => {
      const u = new URL(route.request().url());
      const jm = (body: unknown) =>
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          headers: { 'access-control-allow-origin': '*' },
          body: JSON.stringify(body),
        });
      if (u.pathname === '/-/versions.json') return jm({ datasette: { version: '1.0a37' } });
      if (u.pathname === '/-/actor.json') return jm({ ok: true, actor: null });
      if (u.pathname === '/db/people.json') {
        if (u.search.includes('_extra=primary_keys'))
          return jm({ ok: true, primary_keys: ['id'], rows: [] });
        if (u.search.includes('_extra=columns'))
          return jm({ ok: true, columns: ['id', 'name'], rows: [] });
        return jm({ ok: true, next: null, rows: people });
      }
      return route.fulfill({ status: 404, body: '{"ok":false}' });
    });

    await page.getByTitle(/Connect a live/).click();
    const dlg = page.locator('datasette-connect-dialog dialog');
    await dlg.locator('input[type="text"]').fill('https://ds.example/db/people');
    await dlg.getByRole('button', { name: 'Connect', exact: true }).click();
    await expect(dlg).toBeHidden();

    const tableId: string = await (async () => {
      await expect
        .poll(() =>
          page.evaluate(async (ws) => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const ts = await (window as any).__easydb.store.tables.find();
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            return ts.some((x: any) => x.workspaceId === ws && x.source?.type === 'datasette');
          }, workspaceId),
        )
        .toBe(true);
      return page.evaluate(async (ws) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const ts = await (window as any).__easydb.store.tables.find();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return ts.find((x: any) => x.workspaceId === ws && x.source?.type === 'datasette').id;
      }, workspaceId);
    })();

    const footer = page.locator(`#${panelDomId(tableId)} panel-footer`);
    await expect(footer).toContainText('2 rows');
    await expect(footer.getByRole('button', { name: 'Refresh' })).toBeVisible();

    // Remote gains a row; Refresh reloads the shared collection → grid + footer update.
    people = [
      { id: 1, name: 'Alice' },
      { id: 2, name: 'Bob' },
      { id: 3, name: 'Carol' },
    ];
    await footer.getByRole('button', { name: 'Refresh' }).click();
    await expect(footer).toContainText('3 rows');
  });

  test('a live table restored minimized fetches nothing until expanded', async ({ page }) => {
    let rowRequests = 0;
    await page.route('https://ds.example/**', (route) => {
      const u = new URL(route.request().url());
      const jm = (body: unknown) =>
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          headers: { 'access-control-allow-origin': '*' },
          body: JSON.stringify(body),
        });
      if (u.pathname === '/db/people.json') {
        if (u.search.includes('_extra='))
          return jm({ ok: true, primary_keys: ['id'], columns: ['id', 'name'], rows: [] });
        rowRequests += 1;
        return jm({
          ok: true,
          next: null,
          rows: [
            { id: 1, name: 'Alice' },
            { id: 2, name: 'Bob' },
          ],
        });
      }
      return route.fulfill({ status: 404, body: '{"ok":false}' });
    });

    // Insert a live table already flagged minimized, then reload so the window
    // manager restores it minimized from persisted geometry.
    const id = await page.evaluate(async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ctx = (window as any).__easydb;
      const tid = crypto.randomUUID();
      await ctx.store.tables.insert({
        id: tid,
        workspaceId: ctx.workspaceId,
        name: 'db/people',
        code: 'db-people',
        columns: [
          { field: 'id', label: 'id', type: 'number' },
          { field: 'name', label: 'name', type: 'string' },
        ],
        view: 'table',
        source: {
          type: 'datasette',
          writable: false,
          config: { base: 'https://ds.example', db: 'db', table: 'people', pks: ['id'] },
        },
        windowGeometry: { x: 60, y: 80, w: 420, h: 220, z: 1, minimized: true, maximized: false },
        updatedAt: Date.now(),
      });
      return tid;
    });

    await page.reload();
    await page.waitForFunction(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      () => Boolean((window as any).__easydb),
    );
    const domId = panelDomId(id);
    await page.locator(`#${domId}`).waitFor({ state: 'attached' });

    // Minimized → no grid mounted AND no row fetch happened.
    await expect(page.locator(`#${domId} .jsPanel-content data-table`)).toHaveCount(0);
    await page.waitForTimeout(300);
    expect(rowRequests).toBe(0);

    // Expand → the grid mounts and only NOW are the remote rows fetched.
    await page.evaluate(
      (d) => (document.getElementById(d) as HTMLElement & { normalize(): void }).normalize(),
      domId,
    );
    await expect(
      page.locator(`#${domId} .jsPanel-content data-table tbody tr:not(.spacer)`),
    ).toHaveCount(2);
    expect(rowRequests).toBeGreaterThan(0);
  });

  test('the connect dialog is prefilled with https://datasette.io', async ({ page }) => {
    await page.getByTitle(/Connect a live/).click();
    const dlg = page.locator('datasette-connect-dialog dialog');
    await expect(dlg).toBeVisible();
    await expect(dlg.locator('input[type="text"]')).toHaveValue('https://datasette.io');
  });

  test("a database URL lists that database's tables (no db picker) and connects them", async ({
    page,
    workspaceId,
  }) => {
    await page.route('https://dbc.example/**', async (route) => {
      const u = new URL(route.request().url());
      const json = (body: unknown) =>
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          headers: { 'access-control-allow-origin': '*' },
          body: JSON.stringify(body),
        });
      switch (u.pathname) {
        case '/-/versions.json':
          return json({ datasette: { version: '1.0a37' } });
        case '/-/actor.json':
          return json({ ok: true, actor: null });
        case '/legislators.json': // the database page → its tables
          return json({
            ok: true,
            tables: [
              { name: 'legislators', count: 10001, primary_keys: ['id'] },
              { name: 'offices', count: 1312, primary_keys: ['id'] },
              { name: 'legislators_fts', count: 0, hidden: true }, // must be skipped
            ],
          });
        case '/legislators/legislators.json':
          if (u.search.includes('_extra=columns'))
            return json({ ok: true, columns: ['id', 'name'], rows: [] });
          if (u.search.includes('_extra=primary_keys'))
            return json({ ok: true, primary_keys: ['id'], rows: [] });
          return json({ ok: true, next: null, rows: [{ id: 1, name: 'A' }] });
        case '/legislators/offices.json':
          if (u.search.includes('_extra=columns'))
            return json({ ok: true, columns: ['id', 'city'], rows: [] });
          if (u.search.includes('_extra=primary_keys'))
            return json({ ok: true, primary_keys: ['id'], rows: [] });
          return json({ ok: true, next: null, rows: [{ id: 1, city: 'DC' }] });
        default:
          return route.fulfill({ status: 404, body: '{"ok":false}' });
      }
    });

    await page.getByTitle(/Connect a live/).click();
    const connect = page.locator('datasette-connect-dialog dialog');
    await connect.locator('input[type="text"]').fill('https://dbc.example/legislators');
    await connect.getByRole('button', { name: 'Connect', exact: true }).click();

    // Goes straight to the table picker (no database step for a single-db URL).
    // The hidden FTS table is shown too — tagged "hidden" and unchecked by
    // default — so it can be opted in, but isn't connected unless ticked.
    const picker = page.locator('table-select-dialog dialog');
    await expect(picker.getByRole('button', { name: /^Connect \(/ })).toBeVisible();
    await expect(picker.locator('ul.tables li .name')).toHaveText([
      'legislators',
      'offices',
      'legislators_fts',
    ]);
    const ftsRow = picker.locator('ul.tables li').filter({ hasText: 'legislators_fts' });
    await expect(ftsRow.locator('.tag-hidden')).toBeVisible();
    await expect(ftsRow.locator('input[type="checkbox"]')).not.toBeChecked();
    // Only the two visible tables are checked → "Connect (2)".
    await picker.getByRole('button', { name: /^Connect \(2\)$/ }).click();

    // Two live tables from the "legislators" database are connected.
    await expect
      .poll(() =>
        page.evaluate(async (ws) => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const ts = (await (window as any).__easydb.store.tables.find())
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            .filter((x: any) => x.workspaceId === ws && x.source?.type === 'datasette')
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            .map((x: any) => `${x.source.config.db}/${x.source.config.table}`)
            .sort();
          return ts;
        }, workspaceId),
      )
      .toEqual(['legislators/legislators', 'legislators/offices']);
  });

  test('connects when the version probe is blocked but table pages read (Cloudflare case)', async ({
    page,
    workspaceId,
  }) => {
    // Mimic datasette.io behind Cloudflare: /-/versions.json + /-/actor.json are
    // challenged (non-JSON), but the database page and table pages read fine.
    await page.route('https://wafed.example/**', async (route) => {
      const u = new URL(route.request().url());
      const json = (body: unknown) =>
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          headers: { 'access-control-allow-origin': '*' },
          body: JSON.stringify(body),
        });
      if (u.pathname === '/-/versions.json' || u.pathname === '/-/actor.json') {
        return route.fulfill({
          status: 200,
          contentType: 'text/html',
          body: '<html>challenge</html>',
        });
      }
      if (u.pathname === '/legislators.json') {
        return json({ ok: true, tables: [{ name: 'offices', count: 1312, primary_keys: ['id'] }] });
      }
      if (u.pathname === '/legislators/offices.json') {
        if (u.search.includes('_extra=columns'))
          return json({ ok: true, columns: ['id', 'city'], rows: [] });
        if (u.search.includes('_extra=primary_keys'))
          return json({ ok: true, primary_keys: ['id'], rows: [] });
        return json({ ok: true, next: null, rows: [{ id: 1, city: 'DC' }] });
      }
      return route.fulfill({ status: 404, body: '{"ok":false}' });
    });

    await page.getByTitle(/Connect a live/).click();
    const connect = page.locator('datasette-connect-dialog dialog');
    await connect.locator('input[type="text"]').fill('https://wafed.example/legislators');
    await connect.getByRole('button', { name: 'Connect', exact: true }).click();

    // The blocked version probe must NOT abort the connect — discovery still works.
    const picker = page.locator('table-select-dialog dialog');
    await expect(picker.getByRole('button', { name: /^Connect \(1\)$/ })).toBeVisible();
    await picker.getByRole('button', { name: /^Connect \(1\)$/ }).click();

    await expect
      .poll(() =>
        page.evaluate(async (ws) => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const t = (await (window as any).__easydb.store.tables.find()).find(
            (x: any) => x.workspaceId === ws && x.source?.type === 'datasette',
          );
          return t ? { table: t.source.config.table, writable: t.source.writable } : null;
        }, workspaceId),
      )
      // Read-only: the probe couldn't confirm auth, so it safely defaults to read-only.
      .toEqual({ table: 'offices', writable: false });
  });

  test('an instance URL lists databases (skipping _memory, honouring custom routes), then tables', async ({
    page,
    workspaceId,
  }) => {
    await page.route('https://inst.example/**', async (route) => {
      const u = new URL(route.request().url());
      const json = (body: unknown) =>
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          headers: { 'access-control-allow-origin': '*' },
          body: JSON.stringify(body),
        });
      switch (u.pathname) {
        case '/-/versions.json':
          return json({ datasette: { version: '1.0a37' } });
        case '/-/actor.json':
          return json({ ok: true, actor: null });
        case '/-/databases.json':
          return json({
            ok: true,
            databases: [
              { name: '_memory', route: '_memory', is_memory: true }, // must be skipped
              { name: 'main', route: 'main' },
              { name: 'special', route: 'alt-route' }, // custom route: name ≠ route
            ],
          });
        case '/main.json':
          return json({ ok: true, tables: [{ name: 'people', count: 2, primary_keys: ['id'] }] });
        case '/alt-route.json': // reached only if the ROUTE (not name 'special') is used
          return json({ ok: true, tables: [{ name: 'widgets', count: 3, primary_keys: ['id'] }] });
        case '/alt-route/widgets.json':
          if (u.search.includes('_extra=columns'))
            return json({ ok: true, columns: ['id', 'label'], rows: [] });
          if (u.search.includes('_extra=primary_keys'))
            return json({ ok: true, primary_keys: ['id'], rows: [] });
          return json({
            ok: true,
            next: null,
            rows: [
              { id: 1, label: 'a' },
              { id: 2, label: 'b' },
              { id: 3, label: 'c' },
            ],
          });
        default:
          return route.fulfill({ status: 404, body: '{"ok":false}' });
      }
    });

    await page.getByTitle(/Connect a live/).click();
    const connect = page.locator('datasette-connect-dialog dialog');
    await connect.locator('input[type="text"]').fill('https://inst.example');
    await connect.getByRole('button', { name: 'Connect', exact: true }).click();

    // Step 1: the database picker — _memory is gone; the custom-route db is
    // listed by its route.
    const picker = page.locator('table-select-dialog dialog');
    await expect(picker.getByRole('button', { name: /Next: choose tables/ })).toBeVisible();
    const dbNames = (await picker.locator('ul.tables li .name').allInnerTexts()).map((s) =>
      s.trim(),
    );
    expect(dbNames).toEqual(['main', 'alt-route']);

    // Choose only the custom-route database.
    await picker.getByRole('button', { name: 'None' }).click();
    await picker.locator('input[type="checkbox"]').nth(1).check(); // alt-route
    await picker.getByRole('button', { name: /Next: choose tables/ }).click();

    // Step 2: the table picker for that database.
    await expect(picker.getByRole('button', { name: /^Connect \(/ })).toBeVisible();
    await expect(picker.locator('ul.tables li .name')).toHaveText(['widgets']);
    await picker.getByRole('button', { name: /^Connect \(1\)$/ }).click();

    // A live table was created for alt-route/widgets with the route as its db.
    await expect
      .poll(() =>
        page.evaluate(async (ws) => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const t = (await (window as any).__easydb.store.tables.find()).find(
            (x: any) => x.workspaceId === ws && x.source?.type === 'datasette',
          );
          if (!t) return null;
          const rows = await (window as any).__easydb.store.rows(t.id).find();
          return { db: t.source.config.db, table: t.source.config.table, rowCount: rows.length };
        }, workspaceId),
      )
      .toEqual({ db: 'alt-route', table: 'widgets', rowCount: 3 });
  });
});
