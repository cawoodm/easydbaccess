import { test, expect, type Page } from './fixtures.js';
import { bulkAddRows, createTable, panelDomId, readRows, waitForPanel } from './helpers.js';

/**
 * A CSV dropped ON a table window names its own destination, so the drop asks
 * what to do with THAT table — append, replace its rows, or make a new table —
 * instead of the generic "review the columns?" question.
 *
 * Append opens the column mapper, because the append path matches the file's
 * columns to the table's by POSITION: right for a file the table came from,
 * silently wrong for anything else.
 */

/** Drop `text` as a CSV file onto the panel of `tableId`, through the real shell. */
async function dropOnPanel(page: Page, tableId: string, filename: string, text: string) {
  await page.evaluate(
    ({ domId, filename, text }) => {
      const panel = document.getElementById(domId)!;
      // The grid, so the event target is deep inside the panel, as a real drop
      // on the table's rows would be.
      const onto = panel.querySelector('data-table') ?? panel;
      const dt = new DataTransfer();
      dt.items.add(new File([text], filename, { type: 'text/csv' }));
      onto.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
    },
    { domId: panelDomId(tableId), filename, text },
  );
}

const dialogs = (page: Page) => page.locator('host-dialogs');
const mapper = (page: Page) => page.locator('column-map-dialog dialog');

async function makeCities(page: Page) {
  const id = await createTable(page, 'Cities', [
    { field: 'city' },
    { field: 'pop', type: 'number' },
  ]);
  await waitForPanel(page, id);
  await bulkAddRows(page, id, [{ city: 'Bern', pop: 134000 }]);
  return id;
}

test('dropping a CSV on a table offers append, replace, or a new table', async ({ page }) => {
  const id = await makeCities(page);
  await dropOnPanel(page, id, 'more.csv', 'city,pop\nZug,30000\n');

  await expect(dialogs(page).getByText(/Import "more\.csv" into "Cities"\?/)).toBeVisible();
  await expect(dialogs(page).locator('button.choice', { hasText: 'Append to this table' })).toBeVisible();
  await expect(
    dialogs(page).locator('button.choice', { hasText: 'Replace the rows of this table' }),
  ).toBeVisible();
  await expect(dialogs(page).locator('button.choice', { hasText: 'A new table' })).toBeVisible();
});

test('append matches the file columns by name, whatever their order', async ({ page }) => {
  const id = await makeCities(page);
  // The table is city,pop — the file is the other way round. By position the
  // population would land in `city`; by name it does not.
  await dropOnPanel(page, id, 'swapped.csv', 'pop,city\n30000,Zug\n');
  await dialogs(page).locator('button.choice', { hasText: 'Append to this table' }).click();

  await expect(mapper(page)).toBeVisible();
  const selects = mapper(page).locator('select');
  await expect(selects).toHaveCount(2);
  await expect(selects.nth(0)).toHaveValue('pop');
  await expect(selects.nth(1)).toHaveValue('city');
  await mapper(page).getByRole('button', { name: 'Append' }).click();
  await expect(mapper(page)).toBeHidden();

  await expect.poll(async () => (await readRows(page, id)).length).toBe(2);
  const rows = await readRows(page, id);
  const zug = rows.find((r) => r.data.city === 'Zug')!;
  expect(zug.data.pop).toBe(30000);
  // The original row is untouched.
  expect(rows.some((r) => r.data.city === 'Bern' && r.data.pop === 134000)).toBe(true);
});

test('a manual remap decides where the values land', async ({ page }) => {
  const id = await makeCities(page);
  // Headers that match nothing, so the mapper opens on the positional guess —
  // which is wrong here: the numbers are in the second column.
  await dropOnPanel(page, id, 'opaque.csv', 'A,B\nZug,30000\n');
  await dialogs(page).locator('button.choice', { hasText: 'Append to this table' }).click();

  const selects = mapper(page).locator('select');
  await expect(selects.nth(0)).toHaveValue('city');
  await expect(selects.nth(1)).toHaveValue('pop');
  // Swap them, freeing each target before claiming it so Append never sits
  // disabled on a duplicate.
  await selects.nth(1).selectOption('');
  await selects.nth(0).selectOption('pop');
  await selects.nth(1).selectOption('city');
  await mapper(page).getByRole('button', { name: 'Append' }).click();

  await expect.poll(async () => (await readRows(page, id)).length).toBe(2);
  const rows = await readRows(page, id);
  // "Zug" was in column A, now mapped to `pop`; the number was in B → `city`.
  const added = rows.find((r) => r.data.city === '30000')!;
  expect(added).toBeTruthy();
  // A non-numeric value in a number column is kept verbatim rather than nulled,
  // so nothing the file carried is thrown away (see csv-import's `coerce`).
  expect(added.data.pop).toBe('Zug');
});

test('the mapper refuses two columns pointing at one field', async ({ page }) => {
  const id = await makeCities(page);
  await dropOnPanel(page, id, 'dup.csv', 'a,b\n1,2\n');
  await dialogs(page).locator('button.choice', { hasText: 'Append to this table' }).click();
  await expect(mapper(page)).toBeVisible();

  const selects = mapper(page).locator('select');
  await selects.nth(0).selectOption('city');
  await selects.nth(1).selectOption('city');
  await expect(mapper(page).getByRole('button', { name: 'Append' })).toBeDisabled();
  await expect(mapper(page).locator('.err')).toContainText('same target');

  // Skipping one clears it.
  await selects.nth(1).selectOption('');
  await expect(mapper(page).getByRole('button', { name: 'Append' })).toBeEnabled();
});

test('replace drops the old rows and keeps the table', async ({ page }) => {
  const id = await makeCities(page);
  await dropOnPanel(page, id, 'fresh.csv', 'city,pop\nZug,30000\nChur,37000\n');
  await dialogs(page)
    .locator('button.choice', { hasText: 'Replace the rows of this table' })
    .click();

  await expect.poll(async () => (await readRows(page, id)).length).toBe(2);
  const rows = await readRows(page, id);
  expect(rows.some((r) => r.data.city === 'Bern')).toBe(false);
  expect(rows.map((r) => r.data.city).sort()).toEqual(['Chur', 'Zug']);
});

test('choosing a new table leaves the dropped-on table alone', async ({ page, workspaceId }) => {
  const id = await makeCities(page);
  await dropOnPanel(page, id, 'others.csv', 'city,pop\nZug,30000\n');
  await dialogs(page).locator('button.choice', { hasText: 'A new table' }).click();
  // Falls through to the ordinary new-table drop question.
  await dialogs(page).locator('button.choice', { hasText: 'Import directly' }).click();

  await expect
    .poll(async () =>
      page.evaluate(async (ws) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const all = await (window as any).__easydb.store.tables.find({ workspaceId: ws });
        return (all as Array<{ name: string }>).map((t) => t.name).sort();
      }, workspaceId),
    )
    .toEqual(['Cities', 'others']);
  expect((await readRows(page, id)).length).toBe(1);
});
