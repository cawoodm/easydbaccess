import { test, expect } from './fixtures.js';
import { addRow, createTable, panelDomId, readRows, waitForPanel } from './helpers.js';

/**
 * Two regressions in the column editor / grid:
 *
 * 1. Saving the column editor rebuilt a fresh ColumnSpec from only its 9
 *    editor-owned fields, silently dropping `width` (and default/description/
 *    units/sortable) on EVERY save — including one that only changed the
 *    renderer. Reported as "column width is lost when I switch renderer".
 * 2. A `boolean` column left without a renderer fell back to a native
 *    `<input type="checkbox">`, which can't distinguish false from
 *    null/''/junk and invites an accidental coercing write. It must show the
 *    raw stored value as plain editable text instead — like every other
 *    unrendered column.
 */

test.describe('column round-trip through the editor', () => {
  test('column width survives a renderer change saved in the editor', async ({ page }) => {
    const id = await createTable(page, 'Widths', [{ field: 'name' }]);
    await waitForPanel(page, id);

    // Give the column a width the way a drag-resize would (data-table's
    // onResizeStart persists via ctx.store.tables.patch({ columns })) —
    // setting it directly is equivalent and avoids simulating a pointer drag.
    await page.evaluate(
      async ({ tableId }) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const ctx = (window as any).__easydb;
        const t = await ctx.store.tables.findOne(tableId);
        const columns = t.columns.map((c: { field: string }) =>
          c.field === 'name' ? { ...c, width: 222 } : c,
        );
        await ctx.store.tables.patch(tableId, { columns, updatedAt: Date.now() });
      },
      { tableId: id },
    );

    const panel = page.locator(`#${panelDomId(id)}`);
    await panel
      .locator('panel-footer')
      .getByRole('button', { name: /Columns/ })
      .click();

    const dialog = page.locator('new-table-dialog dialog');
    await expect(dialog).toBeVisible();

    // Change the renderer on the (only) column — the type select is first,
    // the renderer select is second.
    await dialog.locator('.col-row').first().locator('select').nth(1).selectOption('link');
    await dialog.getByRole('button', { name: /Save|Create/ }).click();
    await expect(dialog).toBeHidden();

    await expect
      .poll(async () => {
        const t = await page.evaluate(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          async (tid) => (window as any).__easydb.store.tables.findOne(tid),
          id,
        );
        return t?.columns[0]?.width;
      })
      .toBe(222);
  });

  test('a boolean column with no renderer shows its raw value, not a checkbox', async ({
    page,
  }) => {
    const id = await createTable(page, 'Flags', [{ field: 'flag', type: 'boolean' }]);
    await waitForPanel(page, id);
    await addRow(page, id, { flag: 'maybe' });

    const panel = page.locator(`#${panelDomId(id)}`);
    const cellInput = panel.locator('data-table tbody tr td input').first();
    await expect(cellInput).toHaveAttribute('type', 'text');
    await expect(cellInput).toHaveValue('maybe');
    // No checkbox anywhere in the row — the old fallback rendered one.
    await expect(panel.locator('data-table tbody tr td input[type="checkbox"]')).toHaveCount(0);

    // Typing round-trips exactly like any other string column: the raw text
    // is stored verbatim, no boolean coercion.
    await cellInput.fill('true');
    await cellInput.dispatchEvent('change');
    await expect.poll(async () => (await readRows(page, id))[0]?.data.flag).toBe('true');
  });
});
