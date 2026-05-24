import { test, expect } from './fixtures.js';
import { addRow, createTable, panelDomId, readRows, waitForPanel } from './helpers.js';

/**
 * TODO § Cell Editing
 * - notnull / max / unique enforced on edit
 * - default applied on Add row
 * - pre-flight scan in column editor blocks save when existing rows would
 *   violate a newly-added constraint
 */

test.describe('cell editing constraints', () => {
  test('notnull rejects empty values with a dialog and reverts', async ({ page }) => {
    const id = await createTable(page, 'Required', [
      { field: 'name' },
    ]);
    await waitForPanel(page, id);
    // Patch the column to set notnull=true (createTable helper doesn't pass flags).
    await page.evaluate(
      async ({ tableId }) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const ctx = (window as any).__easydb;
        const t = await ctx.store.tables.findOne(tableId);
        const cols = t.columns.map((c: { field: string }) =>
          c.field === 'name' ? { ...c, notnull: true } : c,
        );
        await ctx.store.tables.patch(tableId, { columns: cols, updatedAt: Date.now() });
      },
      { tableId: id },
    );
    await addRow(page, id, { name: 'Alice' });

    const panel = page.locator(`#${panelDomId(id)}`);
    const input = panel.locator('data-table tbody tr td input').first();
    await input.fill('');
    await input.dispatchEvent('change');

    // Alert pops with the rejection reason.
    const dialog = page.locator('host-dialogs');
    await expect(dialog.getByText(/cannot be empty/i)).toBeVisible();
    await dialog.getByRole('button', { name: 'OK', exact: true }).click();

    // Persisted value is unchanged (Alice, not empty).
    const rows = await readRows(page, id);
    expect(rows[0]?.data.name).toBe('Alice');
  });

  test('max length rejects overlong strings', async ({ page }) => {
    const id = await createTable(page, 'Limit', [{ field: 'code' }]);
    await waitForPanel(page, id);
    await page.evaluate(
      async ({ tableId }) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const ctx = (window as any).__easydb;
        const t = await ctx.store.tables.findOne(tableId);
        const cols = t.columns.map((c: { field: string }) =>
          c.field === 'code' ? { ...c, max: 5 } : c,
        );
        await ctx.store.tables.patch(tableId, { columns: cols, updatedAt: Date.now() });
      },
      { tableId: id },
    );
    await addRow(page, id, { code: 'abc' });

    const panel = page.locator(`#${panelDomId(id)}`);
    const input = panel.locator('data-table tbody tr td input').first();
    await input.fill('abcdefghi'); // 9 chars, max is 5
    await input.dispatchEvent('change');

    const dialog = page.locator('host-dialogs');
    await expect(dialog.getByText(/at most 5/i)).toBeVisible();
    await dialog.getByRole('button', { name: 'OK', exact: true }).click();

    const rows = await readRows(page, id);
    expect(rows[0]?.data.code).toBe('abc');
  });

  test('unique rejects duplicate values', async ({ page }) => {
    const id = await createTable(page, 'Codes', [{ field: 'code' }]);
    await waitForPanel(page, id);
    await page.evaluate(
      async ({ tableId }) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const ctx = (window as any).__easydb;
        const t = await ctx.store.tables.findOne(tableId);
        const cols = t.columns.map((c: { field: string }) =>
          c.field === 'code' ? { ...c, unique: true } : c,
        );
        await ctx.store.tables.patch(tableId, { columns: cols, updatedAt: Date.now() });
      },
      { tableId: id },
    );
    await addRow(page, id, { code: 'A1' });
    await addRow(page, id, { code: 'A2' });

    const panel = page.locator(`#${panelDomId(id)}`);
    // RxDB query order isn't deterministic across runs; find the input
    // showing 'A2' specifically and edit IT to collide with the other row.
    const inputs = await panel.locator('data-table tbody tr td input').all();
    let a2Input: (typeof inputs)[number] | null = null;
    for (const inp of inputs) {
      if ((await inp.inputValue()) === 'A2') {
        a2Input = inp;
        break;
      }
    }
    expect(a2Input).not.toBeNull();
    await a2Input!.fill('A1');
    await a2Input!.dispatchEvent('change');

    const dialog = page.locator('host-dialogs');
    await expect(dialog.getByText(/must be unique/i)).toBeVisible();
    await dialog.getByRole('button', { name: 'OK', exact: true }).click();

    const rows = await readRows(page, id);
    const codes = rows.map((r: { data: { code: unknown } }) => r.data.code).sort();
    expect(codes).toEqual(['A1', 'A2']);
  });

  test('Add row uses Column.default when defined', async ({ page }) => {
    const id = await createTable(page, 'WithDefault', [{ field: 'status' }]);
    await waitForPanel(page, id);
    await page.evaluate(
      async ({ tableId }) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const ctx = (window as any).__easydb;
        const t = await ctx.store.tables.findOne(tableId);
        const cols = t.columns.map((c: { field: string }) =>
          c.field === 'status' ? { ...c, default: 'pending' } : c,
        );
        await ctx.store.tables.patch(tableId, { columns: cols, updatedAt: Date.now() });
      },
      { tableId: id },
    );

    const panel = page.locator(`#${panelDomId(id)}`);
    await panel.locator('panel-footer').getByRole('button', { name: /Add row/ }).click();

    await expect
      .poll(async () => (await readRows(page, id))[0]?.data.status)
      .toBe('pending');
  });

  test('pre-flight scan blocks unique save when existing rows would collide', async ({ page }) => {
    const id = await createTable(page, 'Dups', [{ field: 'code' }]);
    await waitForPanel(page, id);
    await addRow(page, id, { code: 'X' });
    await addRow(page, id, { code: 'X' }); // duplicate already present

    const panel = page.locator(`#${panelDomId(id)}`);
    await panel.locator('panel-footer').getByRole('button', { name: /Columns/ }).click();

    const dialog = page.locator('new-table-dialog dialog');
    await expect(dialog).toBeVisible();

    // Tick the "unique" checkbox on the first (only) column. It's labeled
    // "Unique" via title; sits in the unique-flag column.
    const uniqueCheckbox = dialog.locator('.col-row').first().locator('input[title="Unique"]');
    await uniqueCheckbox.check();

    await dialog.getByRole('button', { name: /Save|Create/ }).click();

    // Dialog stays open and surfaces an error message about existing rows.
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('.error')).toContainText(/row.*violate/i);

    // Table column was NOT patched.
    const tcheck = await page.evaluate(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async (tid) => (window as any).__easydb.store.tables.findOne(tid),
      id,
    );
    expect(tcheck?.columns[0]?.unique).toBeUndefined();
  });
});
