import { test, expect } from './fixtures.js';
import { panelDomId } from './helpers.js';

/**
 * A URL import records where it came from (Table.origin), so the table can be
 * refreshed later and the source URL survives a dump for reconstruction on
 * another device.
 */

test('CSV URL import stores its origin and Refresh re-pulls updated rows', async ({
  page,
  workspaceId,
}) => {
  let body = 'city,pop\nBern,133\nZug,30\n';
  await page.route('https://ex.example/air.csv', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'text/plain; charset=utf-8',
      headers: { 'access-control-allow-origin': '*' },
      body,
    }),
  );

  await page.getByTitle('Import data from a URL').click();
  const dlg = page.locator('import-dialog dialog');
  await dlg.locator('input[type="text"]').fill('https://ex.example/air.csv');
  await dlg.getByTestId('import-format').selectOption('csv');
  await dlg.getByRole('button', { name: 'Import', exact: true }).click();

  const tableId = await page.evaluate(async (ws) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const store = (window as any).__easydb.store;
    for (let i = 0; i < 100; i++) {
      const t = (await store.tables.find()).find(
        (x: any) => x.workspaceId === ws && x.name === 'air',
      );
      if (t) return t.id as string;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error('table not created');
  }, workspaceId);

  // Origin URL recorded.
  const origin = await page.evaluate(async (id) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (await (window as any).__easydb.store.tables.findOne(id)).origin;
  }, tableId);
  expect(origin).toEqual({ type: 'csv', url: 'https://ex.example/air.csv' });

  // The upstream data changes; the per-table Refresh button (panel footer)
  // re-pulls it.
  body = 'city,pop\nBern,999\nZug,30\nLuzern,80\n';
  const footer = page.locator(`#${panelDomId(tableId)} panel-footer`);
  await footer.getByRole('button', { name: 'Refresh' }).click();

  await expect
    .poll(() =>
      page.evaluate(async (id) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return (await (window as any).__easydb.store.rows(id).find()).length;
      }, tableId),
    )
    .toBe(3); // was 2, now 3 after refresh
});

test('a dump round-trips a snapshot origin (reconstructable on another device)', async ({
  page,
  workspaceId,
}) => {
  // Build a table that carries an origin, export the workspace, wipe it, then
  // re-import the dump — the origin must survive.
  const dump = await page.evaluate(async (ws) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ctx = (window as any).__easydb;
    const id = crypto.randomUUID();
    await ctx.store.tables.insert({
      id,
      workspaceId: ws,
      name: 'FromUrl',
      code: 'fromurl',
      columns: [{ field: 'a', label: 'A', type: 'string' }],
      view: 'table',
      origin: { type: 'csv', url: 'https://ex.example/x.csv' },
      updatedAt: Date.now(),
    });
    await ctx.store
      .rows(id)
      .insert({ id: crypto.randomUUID(), tableId: id, data: { a: '1' }, updatedAt: Date.now() });
    const { serializeWorkspace } = await import('/src/plugins/dump-export.ts');
    const text = await serializeWorkspace(ctx.api);
    // Wipe the table so the re-import recreates it.
    await ctx.store.rows(id).bulkRemove((await ctx.store.rows(id).find()).map((r: any) => r.id));
    await ctx.store.tables.remove(id);
    return text;
  }, workspaceId);

  // The dump carries the origin.
  expect(JSON.parse(dump).tables[0].origin).toEqual({
    type: 'csv',
    url: 'https://ex.example/x.csv',
  });

  // Re-import the dump; the reconstructed table keeps its origin.
  const origin = await page.evaluate(
    async (args) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ctx = (window as any).__easydb;
      const { importJsonText } = await import('/src/plugins/json-import.ts');
      await importJsonText(ctx.api, args.dump, 'restore.json');
      const t = (await ctx.store.tables.find()).find(
        (x: any) => x.workspaceId === args.ws && x.name === 'FromUrl',
      );
      return t?.origin ?? null;
    },
    { dump, ws: workspaceId },
  );

  expect(origin).toEqual({ type: 'csv', url: 'https://ex.example/x.csv' });
});
