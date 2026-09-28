import type { Page } from '@playwright/test';
import { test, expect } from './fixtures.js';
import { addRow, createTable, panelDomId, readRows, waitForPanel } from './helpers.js';

/**
 * Writing a scripted column and seeing it work, without leaving the dialog.
 *
 * Two things stood between typing a script and knowing whether it was right:
 *
 *  - **Run refused a column that was not saved yet.** It said so clearly, and
 *    the way out was "close, save, reopen, press Run" — three steps that teach
 *    nothing. Run now offers to add the column and then runs.
 *  - **A broken script said nothing until it ran.** The columns editor is
 *    already previewing real rows two inches below; the same rows now judge the
 *    script as it is typed.
 */

const columnsEditor = (page: Page) => page.locator('new-table-dialog dialog');
const scriptEditor = (page: Page) => page.locator('script-editor-dialog dialog');
const issue = (page: Page) => scriptEditor(page).locator('[data-testid="script-issue"]');

async function openColumns(page: Page, tableId: string): Promise<void> {
  await page
    .locator(`#${panelDomId(tableId)}`)
    .locator('panel-footer')
    .getByRole('button', { name: /Columns/ })
    .click();
  await expect(columnsEditor(page)).toBeVisible();
}

/** Add a column row, name it, and open its script editor. */
async function addScriptedColumn(page: Page, field: string): Promise<void> {
  const dlg = columnsEditor(page);
  await dlg.getByRole('button', { name: '+ Add column' }).click();
  // The field box has no class of its own — its `title` is what names it, the
  // same way a user picks it out.
  await dlg.locator('input[title^="Field"]').last().fill(field);
  await dlg.locator('button.script-btn').last().click();
  await expect(scriptEditor(page)).toBeVisible();
}

test.describe('running a script on a column that is not saved yet', () => {
  test('Run offers to add the column, then writes the cells', async ({ page }) => {
    const id = await createTable(page, 'Parts', [{ field: 'sku' }, { field: 'qty', type: 'number' }]);
    await waitForPanel(page, id);
    await addRow(page, id, { sku: 'A-1', qty: 4 });
    await addRow(page, id, { sku: 'B-2', qty: 9 });

    await openColumns(page, id);
    await addScriptedColumn(page, 'label');
    await scriptEditor(page).locator('textarea').fill('function render(row) { return row.sku + " x" + row.qty; }');

    await scriptEditor(page).getByRole('button', { name: 'Run…' }).click();

    // The offer. Before this, Run could only explain that there was nowhere to
    // write — true, and useless to someone who has just typed the script.
    const ask = page.locator('host-dialogs');
    await expect(ask.locator('dialog')).toBeVisible();
    await expect(ask).toContainText(/not part of the table yet/i);
    await ask.getByRole('button', { name: 'Yes', exact: true }).click();

    // Then the ordinary Run confirmation — the column exists now, so this is
    // the same question any Run asks.
    await expect(ask.locator('dialog')).toBeVisible();
    await expect(ask).toContainText(/Write what this script returns/i);
    await ask.getByRole('button', { name: 'Run and keep enabled', exact: true }).click();

    await expect.poll(async () => (await readRows(page, id)).map((r: { data: Record<string, unknown> }) => r.data['label']).sort()).toEqual(['A-1 x4', 'B-2 x9']);
  });

  test('declining the offer adds nothing', async ({ page }) => {
    const id = await createTable(page, 'Parts', [{ field: 'sku' }]);
    await waitForPanel(page, id);
    await addRow(page, id, { sku: 'A-1' });

    await openColumns(page, id);
    await addScriptedColumn(page, 'label');
    await scriptEditor(page).locator('textarea').fill('function render(row) { return row.sku; }');
    await scriptEditor(page).getByRole('button', { name: 'Run…' }).click();

    const ask = page.locator('host-dialogs');
    await expect(ask.locator('dialog')).toBeVisible();
    await ask.getByRole('button', { name: 'No', exact: true }).click();

    // Backing out of the offer is backing out of the SAVE too — the column is
    // still a draft, so the table has not grown a column nobody confirmed.
    const cols = await page.evaluate(async (tableId) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const t = await (window as any).__easydb.store.tables.findOne(tableId);
      return (t?.columns ?? []).map((c: { field: string }) => c.field);
    }, id);
    expect(cols).toEqual(['sku']);
  });
});

test.describe('a broken script says so while it is being typed', () => {
  test('a script that cannot compile is called out', async ({ page }) => {
    const id = await createTable(page, 'Notes', [{ field: 'body' }]);
    await waitForPanel(page, id);
    await addRow(page, id, { body: 'hello' });

    await openColumns(page, id);
    await columnsEditor(page).locator('button.script-btn').first().click();
    await expect(scriptEditor(page)).toBeVisible();
    await expect(issue(page)).toHaveCount(0);

    await scriptEditor(page).locator('textarea').fill('function render(row) { retrun row.body }');
    await expect(issue(page)).toContainText(/compile error/i);
  });

  test('it counts the rows that break, and clears when the script is fixed', async ({ page }) => {
    const id = await createTable(page, 'Notes', [{ field: 'body' }]);
    await waitForPanel(page, id);
    await addRow(page, id, { body: 'hello' });
    await addRow(page, id, {});

    await openColumns(page, id);
    await columnsEditor(page).locator('button.script-btn').first().click();

    // One of the two rows has no `body`. The COUNT is the diagnosis: one row is
    // a row with a surprise in it, all of them is a wrong script.
    await scriptEditor(page).locator('textarea').fill('function render(row) { return row.body.toUpperCase() }');
    await expect(issue(page)).toContainText(/fails on 1 of 2 preview rows/i);

    await scriptEditor(page).locator('textarea').fill('function render(row) { return (row.body ?? "").toUpperCase() }');
    await expect(issue(page)).toHaveCount(0);
  });

  test('a validation rule is not judged as a render script', async ({ page }) => {
    const id = await createTable(page, 'Notes', [{ field: 'body' }]);
    await waitForPanel(page, id);
    await addRow(page, id, { body: 'hello' });

    await openColumns(page, id);
    // The OTHER pencil on the same column. A `validate(value, row)` run as
    // `render(row)` would report a failure that is only the wrong calling
    // convention — so it is not checked at all.
    await columnsEditor(page).locator('button.validate-btn').first().click();
    await expect(scriptEditor(page)).toBeVisible();
    await expect(issue(page)).toHaveCount(0);
  });
});
