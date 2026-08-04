import { test, expect } from './fixtures.js';
import { panelDomId } from './helpers.js';

/**
 * A slow-loading table shows an indeterminate progress bar in its header while
 * the rows are still loading, then hides it once they arrive. Driven through a
 * live Datasette connection whose row request is deliberately delayed.
 */

test('shows a header loading bar while a large/slow table loads, then hides it', async ({ page, workspaceId }) => {
  await page.route('https://ds.example/**', async (route) => {
    const u = new URL(route.request().url());
    const json = (body: unknown) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: { 'access-control-allow-origin': '*' },
        body: JSON.stringify(body),
      });
    if (u.pathname === '/-/versions.json') return json({ datasette: { version: '1.0a37' } });
    if (u.pathname === '/-/actor.json') return json({ ok: true, actor: null });
    if (u.pathname === '/db/people.json') {
      if (u.search.includes('_extra=columns')) return json({ ok: true, columns: ['id', 'name'], rows: [] });
      if (u.search.includes('_extra=primary_keys')) return json({ ok: true, primary_keys: ['id'], rows: [] });
      if (u.search.includes('_size=50')) return json({ ok: true, next: null, rows: [{ id: 1, name: 'A' }] });
      // The panel's live row load (_size=1000) — delay it so the loading bar
      // is on screen long enough to observe.
      await new Promise((r) => setTimeout(r, 1500));
      return json({
        ok: true,
        next: null,
        rows: [
          { id: 1, name: 'A' },
          { id: 2, name: 'B' },
        ],
      });
    }
    return route.fulfill({ status: 404, body: '{"ok":false}' });
  });

  await page.getByTitle(/Connect a live/).click();
  const dlg = page.locator('datasette-connect-dialog dialog');
  await dlg.locator('input[type="text"]').fill('https://ds.example/db/people');
  await dlg.getByRole('button', { name: 'Connect', exact: true }).click();

  const tableId: string = await (async () => {
    return await page.evaluate(async (ws) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const store = (window as any).__easydb.store;
      for (let i = 0; i < 100; i++) {
        const t = (await store.tables.find()).find((x: any) => x.workspaceId === ws && x.source?.type === 'datasette');
        if (t) return t.id as string;
        await new Promise((r) => setTimeout(r, 50));
      }
      throw new Error('live table never created');
    }, workspaceId);
  })();

  const bar = page.locator(`#${panelDomId(tableId)}`).locator('.load-bar');
  // Appears during the delayed load…
  await expect(bar).toBeVisible();
  // …and is gone once the rows arrive.
  await expect(bar).toBeHidden({ timeout: 5000 });

  // Rows did load.
  const rowCount = await page.evaluate(async (id) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (await (window as any).__easydb.store.rows(id).find()).length;
  }, tableId);
  expect(rowCount).toBe(2);
});
