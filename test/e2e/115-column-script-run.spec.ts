import { test, expect } from './fixtures.js';
import { addRow, bulkAddRows, createTable, panelDomId, readRows, waitForPanel } from './helpers.js';

/**
 * The script editor's **Run**: take what `render(row)` returns and WRITE it into
 * the cells, turning a computed column into ordinary data.
 *
 * Everything else about a column script leaves the stored cell alone, so this is
 * the one path that changes data the user cannot get back — hence the two
 * questions before it writes, and hence these tests are about the questions as
 * much as about the write.
 */

const UPPER = 'function render(row) { return String(row.name).toUpperCase(); }';

/** Open Columns → the script pencil of column `idx` → the editor. */
async function openScript(page: import('@playwright/test').Page, tableId: string, idx: number) {
  await page
    .locator(`#${panelDomId(tableId)}`)
    .locator('panel-footer')
    .getByRole('button', { name: /Columns/ })
    .click();
  const dlg = page.locator('new-table-dialog dialog');
  await expect(dlg).toBeVisible();
  await dlg.locator('button.script-btn').nth(idx).click();
  const editor = page.locator('script-editor-dialog dialog');
  await expect(editor).toBeVisible();
  return { dlg, editor };
}

test('Run writes the script’s value into the cells and NEVER clears the script', async ({ page }) => {
  const id = await createTable(page, 'Runner', [{ field: 'name' }, { field: 'shout' }]);
  await waitForPanel(page, id);
  await addRow(page, id, { name: 'ada' });
  await addRow(page, id, { name: 'bob' });

  const { dlg, editor } = await openScript(page, id, 1);
  await editor.locator('textarea').fill(UPPER);
  await editor.getByTestId('script-run').click();

  // One question only: nothing is filtered, so "which rows" has a single answer.
  // Run never offers to destroy the script — the most it offers is to PARK one,
  // and this test takes the other branch.
  const host = page.locator('host-dialogs');
  await expect(host.getByRole('button', { name: 'Write and clear the script', exact: true })).toHaveCount(0);
  await host.getByRole('button', { name: 'Run and keep enabled', exact: true }).click();

  // The write is immediate — it does not wait for the columns editor's Save.
  await expect.poll(async () => (await readRows(page, id)).map((r: { data: Record<string, unknown> }) => r.data['shout']).sort()).toEqual(['ADA', 'BOB']);

  // The editor stays open: there is nothing left to decide, and closing it would
  // throw away edits that have not been saved to the column yet.
  await expect(editor).toBeVisible();
  await editor.getByRole('button', { name: 'Save' }).click();
  await dlg.getByRole('button', { name: /Save|Create/ }).click();
  await expect(dlg).toBeHidden();

  const table = await page.evaluate(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async (tid) => (await (window as any).__easydb.store.tables.findOne(tid)).columns,
    id,
  );
  expect(table[1].script).toContain('toUpperCase');
});

test('a run stamps the rows it wrote, so replication sees the change', async ({ page }) => {
  // The write used to go through `patch(id, { data })`, which spreads over the
  // stored doc and left `updatedAt` on its old value — so a materialized column
  // looked untouched to a merge, which settles a row by comparing stamps.
  const id = await createTable(page, 'Stamped', [{ field: 'name' }, { field: 'shout' }]);
  await waitForPanel(page, id);
  await bulkAddRows(page, id, [{ name: 'ada' }]);
  const before = (await readRows(page, id))[0].updatedAt;

  const { editor } = await openScript(page, id, 1);
  await editor.locator('textarea').fill(UPPER);
  await editor.getByTestId('script-run').click();
  await page.locator('host-dialogs').getByRole('button', { name: 'Run and keep enabled', exact: true }).click();

  await expect.poll(async () => (await readRows(page, id))[0].data['shout']).toBe('ADA');
  expect((await readRows(page, id))[0].updatedAt).toBeGreaterThan(before);
});

test('Run asks which rows when the grid is filtered, and honours the answer', async ({ page }) => {
  const id = await createTable(page, 'Scoped', [{ field: 'name' }, { field: 'shout' }]);
  await waitForPanel(page, id);
  await bulkAddRows(page, id, [{ name: 'ada' }, { name: 'bob' }, { name: 'cy' }]);

  // Narrow the grid to one row; the pane the editor reads is the same set.
  const funnel = page.locator(`#${panelDomId(id)} data-table filter-combobox`).first();
  await funnel.locator('input').fill('ada');
  await expect(page.locator(`#${panelDomId(id)} data-table tbody tr`)).toHaveCount(1);

  const { editor } = await openScript(page, id, 1);
  await editor.locator('textarea').fill(UPPER);
  await editor.getByTestId('script-run').click();

  const host = page.locator('host-dialogs');
  await host.getByRole('button', { name: 'Only the 1 rows shown', exact: true }).click();
  await host.getByRole('button', { name: 'Run and keep enabled', exact: true }).click();

  // Only the filtered row is written; the other two keep an empty cell.
  await expect.poll(async () => (await readRows(page, id)).filter((r: { data: Record<string, unknown> }) => r.data['shout'] !== undefined).length).toBe(1);
});

test('Run says why it cannot run while the table is still being created', async ({ page }) => {
  // There are no rows to write to yet, and the field is not a key any row uses.
  // The button is never greyed out: a control that does nothing and says nothing
  // about why is worse than one that answers in a sentence.
  await page
    .locator('app-shell')
    .getByRole('button', { name: /New table/i })
    .click();
  const dlg = page.locator('new-table-dialog dialog');
  await expect(dlg).toBeVisible();
  await dlg.locator('button.script-btn').first().click();
  const editor = page.locator('script-editor-dialog dialog');
  await expect(editor).toBeVisible();
  await expect(editor.getByTestId('script-run')).toBeEnabled();

  await editor.getByTestId('script-run').click();
  await expect(page.locator('host-dialogs')).toContainText('no rows to write to yet');
  await page.locator('host-dialogs').getByRole('button', { name: 'OK', exact: true }).click();
});

test('Run says so when the editor is empty, rather than greying out', async ({ page }) => {
  const id = await createTable(page, 'Empty script', [{ field: 'name' }, { field: 'shout' }]);
  await waitForPanel(page, id);
  const { editor } = await openScript(page, id, 1);
  await editor.locator('textarea').fill('');

  await expect(editor.getByTestId('script-run')).toBeEnabled();
  await editor.getByTestId('script-run').click();
  await expect(page.locator('host-dialogs')).toContainText('no script to run');
});

test('an enabled script is offered “Run and disable”, which unticks Enable for the Save', async ({ page }) => {
  // The editor does not own the column — both halves of what it holds ride back
  // on Save — so "and disable" here means unticking the box and saying so.
  const id = await createTable(page, 'Parker', [{ field: 'name' }, { field: 'shout' }]);
  await waitForPanel(page, id);
  await addRow(page, id, { name: 'ada' });

  const { dlg, editor } = await openScript(page, id, 1);
  await editor.locator('textarea').fill(UPPER);
  await editor.getByTestId('script-run').click();

  const host = page.locator('host-dialogs');
  await expect(host).toContainText('it will run continuously');
  await host.getByRole('button', { name: 'Run and disable', exact: true }).click();

  await expect.poll(async () => (await readRows(page, id))[0].data['shout']).toBe('ADA');
  await expect(editor.locator('input[data-testid="script-active"]')).not.toBeChecked();

  await editor.getByRole('button', { name: 'Save' }).click();
  await dlg.getByRole('button', { name: /Save|Create/ }).click();
  await expect(dlg).toBeHidden();

  const columns = await page.evaluate(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async (tid) => (await (window as any).__easydb.store.tables.findOne(tid)).columns,
    id,
  );
  expect(columns[1].scriptActive).toBe(false);
  // Parked, not deleted.
  expect(columns[1].script).toContain('toUpperCase');
});

test('a parked script still runs from the button, and its cells stay editable', async ({ page }) => {
  // **Enable** off is what makes a column stop computing on every draw. It must
  // not stop Run — running by hand is the reason to park a script rather than
  // delete it — and the written values must be ordinary, typeable data.
  const id = await createTable(page, 'Parked runner', [{ field: 'name' }, { field: 'shout' }]);
  await waitForPanel(page, id);
  await addRow(page, id, { name: 'ada' });

  const { dlg, editor } = await openScript(page, id, 1);
  await editor.locator('textarea').fill(UPPER);
  await editor.locator('input[data-testid="script-active"]').setChecked(false);
  await editor.getByTestId('script-run').click();
  await page.locator('host-dialogs').getByRole('button', { name: 'Yes', exact: true }).click();
  await expect.poll(async () => (await readRows(page, id))[0].data['shout']).toBe('ADA');

  await editor.getByRole('button', { name: 'Save' }).click();
  await dlg.getByRole('button', { name: /Save|Create/ }).click();
  await expect(dlg).toBeHidden();

  // An editable input holding the written value: the script is parked, so the
  // grid is showing stored data and the cell can be typed into.
  const cell = page.locator(`#${panelDomId(id)} data-table tbody tr td`).nth(1);
  await expect(cell.locator('input')).toHaveValue('ADA');
  await cell.locator('input').fill('typed');
  await cell.locator('input').dispatchEvent('change');
  await expect.poll(async () => (await readRows(page, id))[0].data['shout']).toBe('typed');

  // And the script is still on the column, ready for the next run.
  const columns = await page.evaluate(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async (tid) => (await (window as any).__easydb.store.tables.findOne(tid)).columns,
    id,
  );
  expect(columns[1].script).toContain('toUpperCase');
  expect(columns[1].scriptActive).toBe(false);
});

test('a long run shows a progress bar', async ({ page }) => {
  const id = await createTable(page, 'Measured', [{ field: 'name' }, { field: 'shout' }]);
  await waitForPanel(page, id);
  // Enough rows to be worth a bar, and under the grid's 500-row page so Run does
  // not also stop to ask which rows to write.
  await bulkAddRows(
    page,
    id,
    Array.from({ length: 450 }, (_, i) => ({ name: `n${i}` })),
  );

  const { editor } = await openScript(page, id, 1);
  await editor.locator('textarea').fill(UPPER);

  // Watched rather than polled: batched writes are fast enough that the bar can
  // come and go between two `expect` attempts, and a test that only passes when
  // the code is slow is worse than no test.
  await page.evaluate(() => {
    // The editor is mounted inside <app-shell>'s shadow root, so `document`
    // cannot see it — Playwright's locators pierce shadow DOM, querySelector
    // does not. Throwing keeps a wrong path from passing as "never appeared".
    const root = document.querySelector('app-shell')?.shadowRoot?.querySelector('script-editor-dialog')?.shadowRoot;
    if (!root) throw new Error('script-editor-dialog shadow root not found');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).__sawProgress = false;
    new MutationObserver(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if (root.querySelector('[data-testid="script-run-progress"]')) (window as any).__sawProgress = true;
    }).observe(root, { childList: true, subtree: true });
  });

  await editor.getByTestId('script-run').click();
  await page.locator('host-dialogs').getByRole('button', { name: 'Run and keep enabled', exact: true }).click();

  await expect.poll(async () => (await readRows(page, id)).filter((r: { data: Record<string, unknown> }) => r.data['shout'] !== undefined).length, { timeout: 30_000 }).toBe(450);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  expect(await page.evaluate(() => (window as any).__sawProgress)).toBe(true);
});

test('a row the script throws on is skipped, and the run says how many', async ({ page }) => {
  const id = await createTable(page, 'Partial', [{ field: 'name' }, { field: 'shout' }]);
  await waitForPanel(page, id);
  await bulkAddRows(page, id, [{ name: 'ada' }, {}, { name: 'cy' }]);

  const { editor } = await openScript(page, id, 1);
  await editor.locator('textarea').fill('function render(row) { if (!row.name) throw new Error("no name"); return row.name.toUpperCase(); }');
  await editor.getByTestId('script-run').click();
  await page.locator('host-dialogs').getByRole('button', { name: 'Run and keep enabled', exact: true }).click();

  await expect.poll(async () => (await readRows(page, id)).map((r: { data: Record<string, unknown> }) => r.data['shout'] ?? '').sort()).toEqual(['', 'ADA', 'CY']);
  await expect(page.locator('toast-host')).toContainText('1 failed');
});
