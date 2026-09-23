import { test, expect, type Page } from './fixtures.js';
import { bulkAddRows, createTable, openRun, panelDomId, readRows, waitForPanel } from './helpers.js';

/**
 * The footer's ▶ **Run** button → **Run scripts**: the whole-table counterpart
 * of the script editor's Run…
 *
 * One dialog asks both questions — which columns (ticked one by one, or All)
 * and which rows. What these tests pin is that both answers are honoured,
 * especially a PARKED script: it is parked so it does not compute on every
 * draw, and running it on demand is the reason to park one rather than delete
 * it.
 *
 * The second question only appears when a chosen script is still enabled:
 * "Run and disable" or "Run and keep enabled". Disabling is the recommended
 * end of a run, because an enabled script goes on recomputing after its output
 * has been written into the cells.
 */

const UPPER = 'function render(row) { return String(row.name).toUpperCase(); }';
const LOWER = 'function render(row) { return String(row.name).toLowerCase(); }';

const picker = (page: Page) => page.locator('run-picker-dialog');
const dialogs = (page: Page) => page.locator('host-dialogs');

/** Open Run → Run scripts and wait for the picker. */
async function openRunScripts(page: Page, id: string) {
  await openRun(page, id, 'Run scripts');
  await picker(page).locator('[data-testid="run-picker"]').waitFor({ state: 'visible' });
  return picker(page);
}

/** Tick exactly these columns, leaving everything else off. */
async function pick(page: Page, fields: string[]) {
  const dlg = picker(page);
  await dlg.locator('[data-testid="run-picker-all"]').setChecked(false);
  for (const f of fields) await dlg.locator(`[data-testid="run-picker-item"][data-field="${f}"]`).check();
}

async function go(page: Page, rows: 'all' | 'visible') {
  const dlg = picker(page);
  await dlg.locator(`[data-testid="run-picker-rows-${rows}"]`).check();
  await dlg.locator('[data-testid="run-picker-go"]').click();
}

const mixed = (page: Page) =>
  createTable(page, 'Mixed', [{ field: 'name' }, { field: 'shout', script: UPPER }, { field: 'quiet', script: LOWER, scriptActive: false }]);

test('runs only the columns that were ticked', async ({ page }) => {
  const id = await mixed(page);
  await waitForPanel(page, id);
  await bulkAddRows(page, id, [{ name: 'Ada' }]);

  await openRunScripts(page, id);
  await pick(page, ['shout']);
  await go(page, 'all');
  // `shout` is live, so the run asks what should happen to it afterwards.
  await dialogs(page).getByRole('button', { name: 'Run and keep enabled' }).click();

  await expect.poll(async () => (await readRows(page, id))[0].data['shout']).toBe('ADA');
  expect((await readRows(page, id))[0].data['quiet']).toBeUndefined();
});

test('runs a parked script on demand, and does not ask about disabling it', async ({ page }) => {
  const id = await mixed(page);
  await waitForPanel(page, id);
  await bulkAddRows(page, id, [{ name: 'Ada' }]);

  await openRunScripts(page, id);
  await pick(page, ['quiet']);
  await go(page, 'all');

  await expect.poll(async () => (await readRows(page, id))[0].data['quiet']).toBe('ada');
  // Nothing was live, so there was nothing to switch off and nothing to ask.
  await expect(dialogs(page).getByRole('button', { name: 'Run and disable' })).toBeHidden();
  expect((await readRows(page, id))[0].data['shout']).toBeUndefined();
});

test('“All” writes every scripted column and keeps the scripts as they were', async ({ page }) => {
  const id = await createTable(page, 'Everything', [
    { field: 'name' },
    { field: 'shout', script: UPPER },
    { field: 'quiet', script: LOWER, scriptActive: false },
  ]);
  await waitForPanel(page, id);
  await bulkAddRows(page, id, [{ name: 'Ada' }, { name: 'Bob' }]);

  await openRunScripts(page, id);
  await go(page, 'all');
  await dialogs(page).getByRole('button', { name: 'Run and keep enabled' }).click();

  await expect.poll(async () => (await readRows(page, id)).map((r: { data: Record<string, unknown> }) => r.data['quiet']).sort()).toEqual(['ada', 'bob']);

  const columns = await page.evaluate(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async (tid) => (await (window as any).__easydb.store.tables.findOne(tid)).columns,
    id,
  );
  expect(columns[1].script).toContain('toUpperCase');
  expect(columns[2].script).toContain('toLowerCase');
  expect(columns[1].scriptActive).not.toBe(false);
  expect(columns[2].scriptActive).toBe(false);
});

test('“Run and disable” parks the scripts it ran, keeping their source', async ({ page }) => {
  const id = await mixed(page);
  await waitForPanel(page, id);
  await bulkAddRows(page, id, [{ name: 'Ada' }]);

  await openRunScripts(page, id);
  await go(page, 'all');
  await dialogs(page).getByRole('button', { name: 'Run and disable' }).click();

  await expect
    .poll(async () => {
      const columns = await page.evaluate(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        async (tid) => (await (window as any).__easydb.store.tables.findOne(tid)).columns,
        id,
      );
      return columns[1].scriptActive;
    })
    .toBe(false);

  const columns = await page.evaluate(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async (tid) => (await (window as any).__easydb.store.tables.findOne(tid)).columns,
    id,
  );
  // Parked, never deleted — running it by hand has to stay possible.
  expect(columns[1].script).toContain('toUpperCase');
  expect((await readRows(page, id))[0].data['shout']).toBe('ADA');
});

test('“Visible rows” writes only what the grid is showing', async ({ page }) => {
  const id = await createTable(page, 'Narrowed', [{ field: 'name' }, { field: 'quiet', script: LOWER, scriptActive: false }]);
  await waitForPanel(page, id);
  await bulkAddRows(page, id, [{ name: 'Ada' }, { name: 'Bob' }, { name: 'Cy' }]);

  const funnel = page.locator(`#${panelDomId(id)} data-table filter-combobox`).first();
  await funnel.locator('input').fill('Ada');
  await expect(page.locator(`#${panelDomId(id)} data-table tbody tr`)).toHaveCount(1);

  await openRunScripts(page, id);
  await go(page, 'visible');

  await expect.poll(async () => (await readRows(page, id)).filter((r: { data: Record<string, unknown> }) => r.data['quiet'] !== undefined).length).toBe(1);
});

test('says so when the table has no scripts at all', async ({ page }) => {
  const id = await createTable(page, 'Bare', [{ field: 'name' }]);
  await waitForPanel(page, id);

  await openRun(page, id, 'Run scripts');
  await expect(dialogs(page)).toContainText('No column of “Bare” carries a script');
  await expect(picker(page).locator('[data-testid="run-picker"]')).toBeHidden();
});
