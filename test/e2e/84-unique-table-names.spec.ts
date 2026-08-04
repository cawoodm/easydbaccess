import { test, expect } from './fixtures.js';
import { addRow, createTable, readRows } from './helpers.js';

/**
 * Two tables in one workspace may never share a name: projections and view
 * instances bind to their source BY NAME, so a duplicate makes every reference
 * to it ambiguous.
 *
 * Dropping a `.table.json` and answering "a new table" used to write the
 * dump's name verbatim, which produced two tables called the same thing. The
 * uniquing now lives in the STORE, so every writer obeys it — the last two
 * cases here poke the store directly, with no importer involved.
 */

/** Run one dropped file through the registered drop handlers. */
async function dropFile(page: import('@playwright/test').Page, filename: string, text: string, type: string) {
  return page.evaluate(
    async ({ filename, text, type }) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ctx = (window as any).__easydb;
      const file = new File([text], filename, { type });
      const dt = new DataTransfer();
      dt.items.add(file);
      const event = new DragEvent('drop', { bubbles: true, dataTransfer: dt });
      for (const fn of ctx.registries.dropHandlers) {
        if (await fn(event, ctx.api)) break;
      }
    },
    { filename, text, type },
  );
}

/** Every table in the workspace, name only, sorted so row order cannot matter. */
async function tableNames(page: import('@playwright/test').Page): Promise<string[]> {
  const tables = await page.evaluate(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    () => (window as any).__easydb.store.tables.find(),
  );
  return (tables as Array<{ name: string }>).map((t) => t.name).sort();
}

/** A single-table export of `people`, as the per-table JSON export writes it. */
const PEOPLE_FILE = JSON.stringify({
  name: 'people',
  columns: [{ field: 'name', label: 'Name', type: 'string' }],
  rows: [{ name: 'Erin' }, { name: 'Frank' }],
});

test('dropping a .table.json and adding it as new gets a free name, not a duplicate', async ({ page }) => {
  const originalId = await createTable(page, 'people', [{ field: 'name' }]);
  await addRow(page, originalId, { name: 'Carol' });

  const dropped = dropFile(page, 'people.table.json', PEOPLE_FILE, 'application/json');
  const dialog = page.locator('host-dialogs');
  // One table naming one existing table asks what to do with THAT table.
  await expect(dialog.getByText(/already exists/i)).toBeVisible();
  await dialog.locator('button.choice', { hasText: 'A new table' }).click();
  await dropped;

  expect(await tableNames(page)).toEqual(['people', 'people-2']);

  // Each table kept its own rows — the import added one, it did not overwrite.
  const tables = await page.evaluate(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    () => (window as any).__easydb.store.tables.find(),
  );
  const added = (tables as Array<{ name: string; id: string }>).find((t) => t.name === 'people-2')!;
  expect((await readRows(page, originalId)).map((r) => r.data.name)).toEqual(['Carol']);
  expect((await readRows(page, added.id)).map((r) => r.data.name).sort()).toEqual(['Erin', 'Frank']);
});

test('the import says which name the table came in under', async ({ page }) => {
  await createTable(page, 'people', [{ field: 'name' }]);

  const dropped = dropFile(page, 'people.table.json', PEOPLE_FILE, 'application/json');
  await page.locator('host-dialogs').locator('button.choice', { hasText: 'A new table' }).click();
  await dropped;

  await expect(page.locator('toast-host').getByText(/came in as .people-2./)).toBeVisible();
});

test('the store refuses a duplicate name whoever writes it', async ({ page }) => {
  await createTable(page, 'places', [{ field: 'name' }]);

  // No importer, no dialog: a bare insert under a name that is taken.
  const stored = await page.evaluate(async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ctx = (window as any).__easydb;
    return ctx.store.tables.insert({
      id: 'dup-test',
      workspaceId: ctx.api.workspaceId(),
      name: 'places',
      code: 'places',
      columns: [{ field: 'name', label: 'Name', type: 'string' }],
      view: 'table',
      updatedAt: Date.now(),
    });
  });

  // The write is not rejected — a rejection would abort a sync pull mid-loop —
  // and the returned document carries the name that was actually stored.
  expect((stored as { name: string; code: string }).name).toBe('places-2');
  expect((stored as { name: string; code: string }).code).toBe('places-2');
  expect(await tableNames(page)).toEqual(['places', 'places-2']);
});

test('a rename onto a taken name is uniqued too', async ({ page }) => {
  await createTable(page, 'places', [{ field: 'name' }]);
  const otherId = await createTable(page, 'people', [{ field: 'name' }]);

  const stored = await page.evaluate(async (id) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ctx = (window as any).__easydb;
    return ctx.store.tables.patch(id, { name: 'places' });
  }, otherId);

  expect((stored as { name: string }).name).toBe('places-2');
  expect(await tableNames(page)).toEqual(['places', 'places-2']);
});
