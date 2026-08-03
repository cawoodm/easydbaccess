import { test, expect } from './fixtures.js';

/**
 * An empty table shell (no columns) must be recoverable: clicking Refresh
 *  - recreates the columns (issue 2), and
 *  - opens the column editor with a message, because these are columns the
 *    table knew nothing about (issue 5).
 * The second test covers that a deleted column is not re-added by a later
 * refresh (issues 3 & 4).
 *
 * The shell is produced by cancelling the pre-import column editor, which the
 * importer deliberately leaves as an empty table rather than aborting a whole
 * batch. It used to be produced by an import that 429'd on its first page, but
 * that no longer creates anything at all: the kernel creates the table lazily
 * from the first batch, so a source that never yields one leaves no trace.
 */
const ROWS = [
  { id: 1, name: 'Kajaki Hydro', capacity_mw: 33 },
  { id: 2, name: 'Kandahar Solar', capacity_mw: 10 },
];

const json = (body: unknown) => ({
  status: 200,
  contentType: 'application/json',
  headers: { 'access-control-allow-origin': '*' },
  body: JSON.stringify(body),
});
const rateLimited = () => ({
  status: 429,
  contentType: 'application/json',
  headers: { 'access-control-allow-origin': '*' },
  body: JSON.stringify({ ok: false, error: 'rate limit exceeded' }),
});

test('an empty table shell recovers on Refresh: columns recreated, editor opened', async ({
  page,
  workspaceId,
}) => {
  await page.route('https://ppl2.example/**', (route) => {
    const u = new URL(route.request().url());
    if (u.pathname === '/-/metadata.json') return route.fulfill(json({}));
    if (u.pathname === '/energy/plants.json') {
      const extra = u.searchParams.get('_extra') ?? '';
      if (extra.includes('columns'))
        return route.fulfill(json({ ok: true, columns: ['id', 'name', 'capacity_mw'], rows: [] }));
      if (extra.includes('count')) return route.fulfill(json({ ok: true, count: ROWS.length }));
      return route.fulfill(json({ ok: true, next: null, rows: ROWS }));
    }
    return route.fulfill({ status: 404, body: '{"ok":false}' });
  });

  // Import with "Edit columns", then cancel that editor → the table is left as
  // an empty shell, columns and rows unwritten.
  await page.getByTitle('Import data from a URL').click();
  const importDialog = page.locator('import-dialog dialog');
  await importDialog.locator('input[type="text"]').fill('https://ppl2.example/energy/plants');
  await importDialog.getByTestId('import-format').selectOption('datasette');
  await importDialog
    .locator('label.check', { hasText: 'Edit columns before import' })
    .locator('input[type="checkbox"]')
    .check();
  await importDialog.getByRole('button', { name: 'Import' }).click();
  // The pre-import editor is `column-names-dialog` (the table's own column
  // editor, `new-table-dialog`, is what Refresh opens further down).
  const preEditor = page.locator('column-names-dialog dialog');
  await expect(preEditor).toBeVisible();
  await preEditor.getByRole('button', { name: 'Cancel' }).click();
  await expect(preEditor).toBeHidden();

  const tableId = await (async () => {
    await expect
      .poll(() =>
        page.evaluate(async (ws) => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const t = (await (window as any).__easydb.store.tables.find()).find(
            (x: { workspaceId: string; name: string }) =>
              x.workspaceId === ws && x.name === 'energy/plants',
          );
          return t ? t.columns.length : -1;
        }, workspaceId),
      )
      .toBe(0); // table exists, no columns (the failed import)
    return page.evaluate(async (ws) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const t = (await (window as any).__easydb.store.tables.find()).find(
        (x: { workspaceId: string; name: string }) =>
          x.workspaceId === ws && x.name === 'energy/plants',
      );
      return t.id as string;
    }, workspaceId);
  })();

  const panelDom = `panel-${tableId.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
  const footer = page.locator(`#${panelDom} panel-footer`);

  // Refresh must recreate the columns and load the rows.
  await footer.getByRole('button', { name: 'Refresh' }).click();

  // Columns recreated (issue 2) + rows loaded.
  await expect
    .poll(() =>
      page.evaluate(async (id) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const store = (window as any).__easydb.store;
        const t = await store.tables.findOne(id);
        const rows = await store.rows(id).find();
        return { cols: t.columns.map((c: { field: string }) => c.field), rows: rows.length };
      }, tableId),
    )
    .toEqual({ cols: ['id', 'name', 'capacity_mw'], rows: 2 });

  // The column editor opened automatically with a "new columns" notice (issue 5).
  const editor = page.locator('new-table-dialog dialog');
  await expect(editor).toBeVisible();
  await expect(editor.locator('.notice')).toContainText(/new column/i);
  await expect(editor.locator('.notice')).toContainText('capacity_mw');
});

test('a deleted column is remembered and not re-added by a later refresh (issues 3 & 4)', async ({
  page,
  workspaceId,
}) => {
  await page.route('https://ppl3.example/**', (route) => {
    const u = new URL(route.request().url());
    if (u.pathname === '/-/metadata.json') return route.fulfill(json({}));
    if (u.pathname === '/energy/plants.json') {
      const extra = u.searchParams.get('_extra') ?? '';
      if (extra.includes('columns'))
        return route.fulfill(json({ ok: true, columns: ['id', 'name', 'capacity_mw'], rows: [] }));
      if (extra.includes('count')) return route.fulfill(json({ ok: true, count: ROWS.length }));
      return route.fulfill(json({ ok: true, next: null, rows: ROWS }));
    }
    return route.fulfill({ status: 404, body: '{"ok":false}' });
  });

  await page.getByTitle('Import data from a URL').click();
  const importDialog = page.locator('import-dialog dialog');
  await importDialog.locator('input[type="text"]').fill('https://ppl3.example/energy/plants');
  await importDialog.getByTestId('import-format').selectOption('datasette');
  await importDialog.getByRole('button', { name: 'Import' }).click();

  const tableId = await (async () => {
    await expect
      .poll(() =>
        page.evaluate(async (ws) => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const t = (await (window as any).__easydb.store.tables.find()).find(
            (x: { workspaceId: string; name: string }) =>
              x.workspaceId === ws && x.name === 'energy/plants',
          );
          return t ? t.columns.length : -1;
        }, workspaceId),
      )
      .toBe(3);
    return page.evaluate(async (ws) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const t = (await (window as any).__easydb.store.tables.find()).find(
        (x: { workspaceId: string; name: string }) =>
          x.workspaceId === ws && x.name === 'energy/plants',
      );
      return t.id as string;
    }, workspaceId);
  })();

  const panelDom = `panel-${tableId.replace(/[^a-zA-Z0-9_-]/g, '_')}`;

  // Open the column editor and delete the last column ("capacity_mw"), then save.
  await page.locator(`#${panelDom} panel-footer`).getByTitle('Edit columns').click();
  const editor = page.locator('new-table-dialog dialog');
  await expect(editor).toBeVisible();
  await editor.locator('.row-del').last().click();
  await editor.getByRole('button', { name: 'Save' }).click();
  await expect(editor).toBeHidden();

  // The deletion is remembered on the table.
  await expect
    .poll(() =>
      page.evaluate(async (id) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const t = await (window as any).__easydb.store.tables.findOne(id);
        return {
          cols: t.columns.map((c: { field: string }) => c.field),
          deleted: t.deletedColumns,
        };
      }, tableId),
    )
    .toEqual({ cols: ['id', 'name'], deleted: ['capacity_mw'] });

  // Refresh re-pulls the full schema — but the deleted column must NOT come back,
  // and the surviving columns keep their order. No editor pops (no new columns).
  await page.locator(`#${panelDom} panel-footer`).getByRole('button', { name: 'Refresh' }).click();
  await expect
    .poll(() =>
      page.evaluate(async (id) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const store = (window as any).__easydb.store;
        const t = await store.tables.findOne(id);
        const rows = await store.rows(id).find();
        return { cols: t.columns.map((c: { field: string }) => c.field), rows: rows.length };
      }, tableId),
    )
    .toEqual({ cols: ['id', 'name'], rows: 2 });
  await expect(page.locator('new-table-dialog dialog')).toBeHidden();
});
