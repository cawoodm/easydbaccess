import { test, expect } from './fixtures.js';

/**
 * When a Datasette import is interrupted part-way, the table keeps the rows that
 * loaded, persists a resume cursor, and shows a RED "Resume import" button in
 * the footer. Clicking it continues from the stored page (with a progress bar),
 * appends the remaining rows, and clears the button when the import completes.
 */
const PAGE1 = {
  ok: true,
  next: 'p2', // more available → the importer follows to page 2
  truncated: false,
  columns: ['id', 'name', 'capacity_mw'],
  rows: [
    { id: 1, name: 'Kajaki Hydro', capacity_mw: 33 },
    { id: 2, name: 'Kandahar Solar', capacity_mw: 10 },
  ],
};
const PAGE2 = {
  ok: true,
  next: null, // exhausts the table
  truncated: false,
  columns: ['id', 'name', 'capacity_mw'],
  rows: [{ id: 3, name: 'Naghlu Dam', capacity_mw: 100 }],
};

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

test('an interrupted import shows a red Resume button that continues from the stored page', async ({
  page,
  workspaceId,
}) => {
  let page2Fails = true; // page-2 hop is rate-limited until we "recover"
  await page.route('https://ppl4.example/**', (route) => {
    const u = new URL(route.request().url());
    if (u.pathname === '/-/metadata.json') return route.fulfill(json({}));
    if (u.pathname === '/energy/plants.json') {
      const extra = u.searchParams.get('_extra') ?? '';
      if (extra.includes('count')) return route.fulfill(json({ ok: true, count: 3 }));
      if (extra) return route.fulfill(json({ ok: true, columns: PAGE1.columns, rows: [] }));
      if (u.searchParams.get('_next') === 'p2')
        return route.fulfill(page2Fails ? rateLimited() : json(PAGE2));
      return route.fulfill(json(PAGE1));
    }
    return route.fulfill({ status: 404, body: '{"ok":false}' });
  });

  await page.getByTitle('Import data from a URL').click();
  const importDialog = page.locator('import-dialog dialog');
  await importDialog.locator('input[type="text"]').fill('https://ppl4.example/energy/plants');
  await importDialog.locator('select').last().selectOption('datasette');
  await importDialog.getByRole('button', { name: 'Import' }).click();

  // The import stops after page 1: the table keeps 2 rows and a resume cursor.
  const tableId = await (async () => {
    await expect
      .poll(() =>
        page.evaluate(async (ws) => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const store = (window as any).__easydb.store;
          const t = (await store.tables.find()).find(
            (x: { workspaceId: string; name: string }) =>
              x.workspaceId === ws && x.name === 'energy/plants',
          );
          if (!t) return null;
          const rows = await store.rows(t.id).find();
          return { rows: rows.length, resume: t.importResume?.loadedRows ?? null };
        }, workspaceId),
      )
      .toEqual({ rows: 2, resume: 2 });
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
  const resumeBtn = footer.getByRole('button', { name: 'Resume import' });

  // The red resume button is shown (and carries the danger class → red styling).
  await expect(resumeBtn).toBeVisible();
  await expect(footer.locator('button.danger')).toBeVisible();

  // The server recovers; clicking Resume continues from page 2 and appends row 3.
  page2Fails = false;
  await resumeBtn.click();

  await expect
    .poll(() =>
      page.evaluate(async (id) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const store = (window as any).__easydb.store;
        const t = await store.tables.findOne(id);
        const rows = await store.rows(id).find();
        return { rows: rows.length, resume: t.importResume ?? null };
      }, tableId),
    )
    .toEqual({ rows: 3, resume: null }); // all rows in; resume cursor cleared

  // The red button disappears once the import is complete.
  await expect(resumeBtn).toHaveCount(0);
});
