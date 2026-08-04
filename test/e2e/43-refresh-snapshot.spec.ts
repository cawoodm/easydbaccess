import { test, expect } from './fixtures.js';

/**
 * Refreshing a CSV/JSON snapshot used to wipe every row and re-parse the body,
 * never re-discovering the columns. Two consequences, both silently wrong:
 *
 *  - a source that had grown a column never showed it;
 *  - a column the user had added locally lost all of its values.
 *
 * Datasette's refresh already did this properly. `import/refresh.ts` now gives
 * every kernel importer the same behaviour, so these are the guards for it.
 */

const V1 = 'city,pop\nBern,133000\nZug,30000\n';
// Same rows, plus a column the source did not have before.
const V2 = 'city,pop,canton\nBern,133000,BE\nZug,30000,ZG\n';

const URL = 'https://ex.example/grow.csv';

async function serve(page: import('@playwright/test').Page, body: string) {
  await page.unroute(URL).catch(() => {});
  await page.route(URL, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'text/plain; charset=utf-8',
      headers: { 'access-control-allow-origin': '*' },
      body,
    }),
  );
}

/** The single table in this workspace: its fields and its row blobs. */
async function snapshot(page: import('@playwright/test').Page, ws: string) {
  return page.evaluate(async (wsId) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const store = (window as any).__easydb.store;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const t = (await store.tables.find()).find((x: any) => x.workspaceId === wsId);
    if (!t) return null;
    const rows = await store.rows(t.id).find();
    return {
      id: t.id,
      fields: t.columns.map((c: { field: string }) => c.field),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      rows: rows.map((r: any) => r.data),
    };
  }, ws);
}

async function importCsv(page: import('@playwright/test').Page) {
  await page.getByTitle('Import data from a URL').click();
  const dlg = page.locator('import-dialog dialog');
  await dlg.locator('input[type="text"]').fill(URL);
  await dlg.getByTestId('import-format').selectOption('csv');
  await dlg.getByRole('button', { name: 'Import', exact: true }).click();
  await expect(dlg).toBeHidden();
}

async function clickRefresh(page: import('@playwright/test').Page) {
  await page.getByTitle(/Reload this table from the URL/).click();
}

test('a refresh discovers a column the source has grown', async ({ page, workspaceId }) => {
  await serve(page, V1);
  await importCsv(page);
  await expect.poll(async () => (await snapshot(page, workspaceId))?.fields).toEqual(['city', 'pop']);

  await serve(page, V2);
  await clickRefresh(page);

  // The new column is appended, not ignored — and the old ones keep their order.
  await expect.poll(async () => (await snapshot(page, workspaceId))?.fields).toEqual(['city', 'pop', 'canton']);
  const after = await snapshot(page, workspaceId);
  expect(after?.rows.map((r) => r.canton).sort()).toEqual(['BE', 'ZG']);
});

test('a refresh keeps a column the user added, and never re-adds a deleted one', async ({ page, workspaceId }) => {
  await serve(page, V1);
  await importCsv(page);
  await expect.poll(async () => (await snapshot(page, workspaceId))?.fields).toEqual(['city', 'pop']);
  const before = await snapshot(page, workspaceId);

  // Add a local column with a value, and record `pop` as deliberately deleted.
  await page.evaluate(
    async ([tableId]) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const store = (window as any).__easydb.store;
      const t = await store.tables.findOne(tableId);
      await store.tables.patch(tableId, {
        columns: [...t.columns.filter((c: { field: string }) => c.field !== 'pop'), { field: 'note', label: 'Note', type: 'string' }],
        deletedColumns: ['pop'],
        updatedAt: Date.now(),
      });
      const rows = await store.rows(tableId).find();
      for (const r of rows) {
        await store.rows(tableId).patch(r.id, { data: { ...r.data, note: `seen ${r.data.city}` } });
      }
    },
    [before!.id] as const,
  );

  await serve(page, V2);
  await clickRefresh(page);

  await expect.poll(async () => (await snapshot(page, workspaceId))?.fields).toEqual(['city', 'note', 'canton']);

  const after = await snapshot(page, workspaceId);
  // `pop` stays gone — a deleted column is not resurrected by a refresh.
  expect(after?.fields).not.toContain('pop');
  expect(after?.fields).toContain('note');
  // …and so do the VALUES the user typed into it. A CSV origin records no
  // primary key, so the rows are matched on their remote content instead —
  // see `mergeRefreshedRows`.
  expect(after?.rows.map((r) => r.note).sort()).toEqual(['seen Bern', 'seen Zug']);
});

test('what the user typed into their own column survives a refresh', async ({ page, workspaceId }) => {
  // The reported bug, end to end: import a snapshot, add a field, fill it in,
  // press Refresh — and find the typing gone.
  await serve(page, V1);
  await importCsv(page);
  await expect.poll(async () => (await snapshot(page, workspaceId))?.rows.length).toBe(2);
  const before = await snapshot(page, workspaceId);

  await page.evaluate(
    async ([tableId]) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const store = (window as any).__easydb.store;
      const t = await store.tables.findOne(tableId);
      await store.tables.patch(tableId, {
        columns: [...t.columns, { field: 'rating', label: 'Rating', type: 'string' }],
        updatedAt: Date.now(),
      });
      const rows = await store.rows(tableId).find();
      for (const r of rows) {
        await store.rows(tableId).patch(r.id, { data: { ...r.data, rating: `${r.data.city}!` } });
      }
    },
    [before!.id] as const,
  );

  // Refresh against a body with an EXTRA row. The extra row proves the refresh
  // actually re-read the source — without it this test would pass even if the
  // button did nothing at all — while the two original rows are untouched at
  // the source, so there is no excuse for losing what the user typed on them.
  await serve(page, V1 + 'Chur,37000\n');
  await clickRefresh(page);

  await expect.poll(async () => (await snapshot(page, workspaceId))?.rows.length).toBe(3);

  const after = await snapshot(page, workspaceId);
  // The user's values stayed with THEIR rows…
  expect(
    after?.rows
      .filter((r) => r.rating)
      .map((r) => `${r.city}=${r.rating}`)
      .sort(),
  ).toEqual(['Bern=Bern!', 'Zug=Zug!']);
  // …and the new row arrived with none, since there was nothing local to carry.
  expect(after?.rows.find((r) => r.city === 'Chur')?.rating).toBeUndefined();
});
