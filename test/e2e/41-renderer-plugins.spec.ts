import { test, expect } from './fixtures.js';
import { createTable, panelDomId, waitForPanel } from './helpers.js';

/**
 * `core-renderers` (one `meta.fixed = true` plugin bundling four cell
 * renderers) was split into four separately-toggleable built-ins: `cell-date`,
 * `cell-datetime`, `cell-boolean`, `cell-script`. `cell-script` was later
 * removed outright — a column script now runs through whatever renderer the
 * column has, so the dedicated renderer was redundant — leaving three. This
 * spec proves (a) each of the three shows up in the Plugin Manager as an
 * ordinary toggleable row — no lock icon — and (b) the split (and later
 * removal) didn't break renderer registration: a `date` column still renders
 * the `<cell-date>` custom element in the grid.
 */

test.describe('split renderer plugins', () => {
  test('cell-date, cell-datetime, cell-boolean are toggleable (no lock icon)', async ({ page }) => {
    await page.evaluate(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).__easydb.api.ui.openPluginManager();
    });
    const dialog = page.locator('plugin-manager-dialog dialog');
    await expect(dialog).toBeVisible();

    // "Cell Date" is a text-prefix of "Cell Datetime" — hasText does substring
    // matching, so the Date lookup needs a negative-lookahead regex to avoid
    // also matching the Datetime row.
    const names: Array<string | RegExp> = [/Cell Date(?!time)/, 'Cell Datetime', 'Cell Boolean'];
    for (const name of names) {
      const row = dialog.locator('.row', { hasText: name });
      await expect(row).toBeVisible();
      // Toggleable rows carry a checkbox, not a lock icon. The checkbox itself
      // is visually hidden (opacity:0) behind the `.slider` it drives — see
      // the `.switch input` CSS — so assert it's present/checked, not visible.
      await expect(row.locator('.lock-icon')).toHaveCount(0);
      await expect(row.locator('input[type="checkbox"]')).toHaveCount(1);
      await expect(row.locator('input[type="checkbox"]')).toBeChecked();
    }

    // The fourth split-out, `cell-script`, was removed outright — it no
    // longer has a Plugin Manager row at all.
    await expect(dialog.locator('.row', { hasText: 'Cell Script' })).toHaveCount(0);
  });

  test('a date column renders the <cell-date> element in the grid', async ({ page }) => {
    const id = await createTable(page, 'Dates', [{ field: 'when', renderer: 'date' }]);
    await waitForPanel(page, id);

    await page.evaluate(
      async ({ tableId }) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const ctx = (window as any).__easydb;
        await ctx.store.rows(tableId).insert({
          id: crypto.randomUUID(),
          tableId,
          data: { when: '2024-03-01' },
          updatedAt: Date.now(),
        });
      },
      { tableId: id },
    );

    const cell = page.locator(`#${panelDomId(id)}`).locator('data-table tbody td cell-date');
    await expect(cell).toBeVisible();
    await expect(cell.locator('input[type="date"]')).toHaveValue('2024-03-01');
  });
});
