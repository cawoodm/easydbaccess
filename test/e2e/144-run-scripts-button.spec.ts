import { test, expect, type Page } from './fixtures.js';
import { bulkAddRows, createTable, panelDomId, readRows, waitForPanel } from './helpers.js';

/**
 * The footer's **Run scripts** button — the whole-table counterpart of the
 * script editor's Run…, beside Validate's ✓.
 *
 * Two questions, in order: which scripts, then which rows. What these tests pin
 * is that the answers are honoured, especially "Only disabled scripts": a parked
 * script is parked so it does NOT compute on every draw, and running it on
 * demand is the reason to park one rather than delete it.
 */

const UPPER = 'function render(row) { return String(row.name).toUpperCase(); }';
const LOWER = 'function render(row) { return String(row.name).toLowerCase(); }';

function footer(page: Page, id: string) {
  return page.locator(`#${panelDomId(id)}`).locator('panel-footer');
}

async function openRunScripts(page: Page, id: string) {
  await footer(page, id)
    .getByRole('button', { name: /Run scripts/ })
    .click();
  return page.locator('host-dialogs');
}

test('runs only the enabled scripts when asked', async ({ page }) => {
  const id = await createTable(page, 'Mixed', [
    { field: 'name' },
    { field: 'shout', script: UPPER },
    { field: 'quiet', script: LOWER, scriptActive: false },
  ]);
  await waitForPanel(page, id);
  await bulkAddRows(page, id, [{ name: 'Ada' }]);

  const host = await openRunScripts(page, id);
  await host.getByRole('button', { name: 'Only enabled scripts (1)', exact: true }).click();
  await host.getByRole('button', { name: /^All rows/ }).click();

  await expect.poll(async () => (await readRows(page, id))[0].data['shout']).toBe('ADA');
  expect((await readRows(page, id))[0].data['quiet']).toBeUndefined();
});

test('runs a parked script on demand — the reason to park rather than delete', async ({ page }) => {
  const id = await createTable(page, 'Parked', [
    { field: 'name' },
    { field: 'shout', script: UPPER },
    { field: 'quiet', script: LOWER, scriptActive: false },
  ]);
  await waitForPanel(page, id);
  await bulkAddRows(page, id, [{ name: 'Ada' }]);

  const host = await openRunScripts(page, id);
  await host.getByRole('button', { name: 'Only disabled scripts (1)', exact: true }).click();
  await host.getByRole('button', { name: /^All rows/ }).click();

  await expect.poll(async () => (await readRows(page, id))[0].data['quiet']).toBe('ada');
  // And the enabled one was left alone, because it was not part of the answer.
  expect((await readRows(page, id))[0].data['shout']).toBeUndefined();
});

test('“All scripts” writes every scripted column and leaves the scripts alone', async ({ page }) => {
  const id = await createTable(page, 'Everything', [
    { field: 'name' },
    { field: 'shout', script: UPPER },
    { field: 'quiet', script: LOWER, scriptActive: false },
  ]);
  await waitForPanel(page, id);
  await bulkAddRows(page, id, [{ name: 'Ada' }, { name: 'Bob' }]);

  const host = await openRunScripts(page, id);
  await host.getByRole('button', { name: 'All scripts (2)', exact: true }).click();
  await host.getByRole('button', { name: /^All rows \(2\)/ }).click();

  await expect.poll(async () => (await readRows(page, id)).map((r: { data: Record<string, unknown> }) => r.data['quiet']).sort()).toEqual(['ada', 'bob']);

  const columns = await page.evaluate(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async (tid) => (await (window as any).__easydb.store.tables.findOne(tid)).columns,
    id,
  );
  expect(columns[1].script).toContain('toUpperCase');
  expect(columns[2].script).toContain('toLowerCase');
  expect(columns[2].scriptActive).toBe(false);
});

test('“Visible rows” writes only what the grid is showing', async ({ page }) => {
  const id = await createTable(page, 'Narrowed', [{ field: 'name' }, { field: 'quiet', script: LOWER, scriptActive: false }]);
  await waitForPanel(page, id);
  await bulkAddRows(page, id, [{ name: 'Ada' }, { name: 'Bob' }, { name: 'Cy' }]);

  const funnel = page.locator(`#${panelDomId(id)} data-table filter-combobox`).first();
  await funnel.locator('input').fill('Ada');
  await expect(page.locator(`#${panelDomId(id)} data-table tbody tr`)).toHaveCount(1);

  const host = await openRunScripts(page, id);
  await host.getByRole('button', { name: 'All scripts (1)', exact: true }).click();
  await host.getByRole('button', { name: /^Visible rows \(1\)/ }).click();

  await expect.poll(async () => (await readRows(page, id)).filter((r: { data: Record<string, unknown> }) => r.data['quiet'] !== undefined).length).toBe(1);
});

test('says so when the table has no scripts at all', async ({ page }) => {
  const id = await createTable(page, 'Bare', [{ field: 'name' }]);
  await waitForPanel(page, id);

  const host = await openRunScripts(page, id);
  await expect(host).toContainText('No column of “Bare” carries a script');
});
