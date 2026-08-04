import { test, expect, type Page } from './fixtures.js';
import { bulkAddRows, createTable, panelDomId, readRows, readTable, waitForPanel } from './helpers.js';

/**
 * A `.table.json` dropped ON a table window names its destination, exactly as a
 * dropped CSV does, and gets the same four answers: Re-Create the table from the
 * file, Re-Load its rows, Append, or make a new table.
 *
 * Before this, a JSON drop ignored the window under the cursor entirely — it
 * always ran the workspace-restore path, so the only way to refresh one table
 * from a file was to let the restore match it by NAME.
 */

/** Drop `text` as a JSON file onto the panel of `tableId`, through the real shell. */
async function dropOnPanel(page: Page, tableId: string, filename: string, text: string) {
  await page.evaluate(
    ({ domId, filename, text }) => {
      const panel = document.getElementById(domId)!;
      // Deep inside the panel, as a real drop on the table's rows would be.
      const onto = panel.querySelector('data-table') ?? panel;
      const dt = new DataTransfer();
      dt.items.add(new File([text], filename, { type: 'application/json' }));
      onto.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
    },
    { domId: panelDomId(tableId), filename, text },
  );
}

const dialogs = (page: Page) => page.locator('host-dialogs');
const mapper = (page: Page) => page.locator('column-map-dialog dialog');

/** A native single-table export: the table's own shape, with two rows. */
const CITIES_FILE = JSON.stringify({
  name: 'Cities',
  columns: [
    { field: 'city', label: 'city', type: 'string' },
    { field: 'pop', label: 'pop', type: 'number' },
  ],
  rows: [
    { city: 'Zug', pop: 30000 },
    { city: 'Chur', pop: 37000 },
  ],
});

async function makeCities(page: Page) {
  const id = await createTable(page, 'Cities', [{ field: 'city' }, { field: 'pop', type: 'number' }]);
  await waitForPanel(page, id);
  await bulkAddRows(page, id, [{ city: 'Bern', pop: 134000 }]);
  return id;
}

test('dropping a .table.json on a table asks what to do with that table', async ({ page }) => {
  const id = await makeCities(page);
  await dropOnPanel(page, id, 'Cities.table.json', CITIES_FILE);

  await expect(dialogs(page).getByText(/Import "Cities\.table\.json" into "Cities"\?/)).toBeVisible();
  await expect(dialogs(page).locator('button.choice', { hasText: 'Re-Create' })).toBeVisible();
  await expect(dialogs(page).locator('button.choice', { hasText: 'Re-Load' })).toBeVisible();
  await expect(dialogs(page).locator('button.choice', { hasText: 'Append the rows' })).toBeVisible();
  await expect(dialogs(page).locator('button.choice', { hasText: 'A new table' })).toBeVisible();
});

test('Re-Load replaces the rows and keeps the columns', async ({ page }) => {
  const id = await makeCities(page);
  // A width proves the column definitions survived, not just their names.
  await page.evaluate(async (tableId) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const store = (window as any).__easydb.store;
    const t = await store.tables.findOne(tableId);
    t.columns[0].width = 222;
    await store.tables.patch(tableId, { columns: t.columns, updatedAt: Date.now() });
  }, id);

  await dropOnPanel(page, id, 'Cities.table.json', CITIES_FILE);
  await dialogs(page).locator('button.choice', { hasText: 'Re-Load' }).click();

  // The file's fields line up with the table, so nothing is asked.
  await expect(mapper(page)).toBeHidden();
  await expect.poll(async () => (await readRows(page, id)).map((r) => r.data.city).sort()).toEqual(['Chur', 'Zug']);
  const tbl = await readTable(page, id);
  expect(tbl.columns[0].width).toBe(222);
});

test('Append keeps the rows that were there', async ({ page }) => {
  const id = await makeCities(page);
  await dropOnPanel(page, id, 'Cities.table.json', CITIES_FILE);
  await dialogs(page).locator('button.choice', { hasText: 'Append the rows' }).click();

  await expect.poll(async () => (await readRows(page, id)).length).toBe(3);
  const rows = await readRows(page, id);
  expect(rows.some((r) => r.data.city === 'Bern' && r.data.pop === 134000)).toBe(true);
});

test('Re-Create takes the columns from the file', async ({ page }) => {
  const id = await makeCities(page);
  const other = JSON.stringify({
    name: 'Cities',
    columns: [
      { field: 'town', label: 'town', type: 'string' },
      { field: 'mayor', label: 'mayor', type: 'string' },
    ],
    rows: [{ town: 'Zug', mayor: 'Ada' }],
  });

  await dropOnPanel(page, id, 'Cities.table.json', other);
  await dialogs(page).locator('button.choice', { hasText: 'Re-Create' }).click();

  await expect.poll(async () => (await readTable(page, id)).columns.map((c: { field: string }) => c.field)).toEqual(['town', 'mayor']);
  const rows = await readRows(page, id);
  expect(rows).toHaveLength(1);
  expect(rows[0]?.data).toMatchObject({ town: 'Zug', mayor: 'Ada' });
  // Still the same table — the id, and so the window and anything bound to it.
  expect((await readTable(page, id)).name).toBe('Cities');
});

test('fields that do not line up open the column mapper', async ({ page }) => {
  const id = await makeCities(page);
  const renamedFields = JSON.stringify({
    name: 'Cities',
    columns: [
      { field: 'town', label: 'town', type: 'string' },
      { field: 'inhabitants', label: 'inhabitants', type: 'number' },
    ],
    rows: [{ town: 'Zug', inhabitants: 30000 }],
  });

  await dropOnPanel(page, id, 'Cities.table.json', renamedFields);
  await dialogs(page).locator('button.choice', { hasText: 'Append the rows' }).click();

  await expect(mapper(page)).toBeVisible();
  const selects = mapper(page).locator('select');
  await expect(selects).toHaveCount(2);
  await selects.nth(0).selectOption('city');
  await selects.nth(1).selectOption('pop');
  await mapper(page).getByRole('button', { name: 'Append' }).click();

  await expect.poll(async () => (await readRows(page, id)).length).toBe(2);
  const added = (await readRows(page, id)).find((r) => r.data.city === 'Zug')!;
  expect(added.data.pop).toBe(30000);
});

test('a multi-table dump says it cannot land in one table', async ({ page }) => {
  const id = await makeCities(page);
  const dump = JSON.stringify({
    tables: [
      { name: 'A', columns: [{ field: 'x', label: 'x', type: 'string' }], rows: [{ x: '1' }] },
      { name: 'B', columns: [{ field: 'y', label: 'y', type: 'string' }], rows: [{ y: '2' }] },
    ],
  });

  await dropOnPanel(page, id, 'both.db.json', dump);

  await expect(page.locator('toast-host').getByText(/holds 2 tables/)).toBeVisible();
  // The dropped-on table is untouched, and nothing was imported behind it.
  expect(await readRows(page, id)).toHaveLength(1);
});

test('choosing a new table leaves the dropped-on table alone', async ({ page, workspaceId }) => {
  const id = await makeCities(page);
  await dropOnPanel(page, id, 'Cities.table.json', CITIES_FILE);
  await dialogs(page).locator('button.choice', { hasText: 'A new table' }).click();
  // Falls through to the ordinary import, which asks the same-name question.
  await dialogs(page).locator('button.choice', { hasText: 'A new table' }).click();

  await expect
    .poll(async () =>
      page.evaluate(async (ws) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const all = await (window as any).__easydb.store.tables.find({ workspaceId: ws });
        return (all as Array<{ name: string }>).map((t) => t.name).sort();
      }, workspaceId),
    )
    .toEqual(['Cities', 'Cities-2']);
  expect(await readRows(page, id)).toHaveLength(1);
});
