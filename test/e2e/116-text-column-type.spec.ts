import { test, expect } from './fixtures.js';
import { addRow, bulkAddRows, createTable, panelDomId, readTable, waitForPanel } from './helpers.js';

/**
 * The `text` column type: prose, as opposed to the short values a `string`
 * column holds.
 *
 * It stores exactly what `string` stores — the type exists so the FILTER can
 * behave differently. A funnel on a text column offers no value list, because
 * every cell is unique and too long to browse: the list would be one useless
 * option per row.
 *
 * The length heuristic in `search/facet-values.ts` reaches the same verdict for
 * most prose, but only from the first hundred rows. These tests are about the
 * type doing it regardless of which rows happen to be loaded.
 */

const BODY = 'Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam.';

/** Drop a CSV on the canvas the way a user would, and wait for its table. */
async function importCsv(page: import('@playwright/test').Page, name: string, text: string) {
  await page.evaluate(
    async ({ name, text }) => {
      const file = new File([text], name, { type: 'text/csv' });
      const dt = new DataTransfer();
      dt.items.add(file);
      const target = document.querySelector('app-shell') ?? document.body;
      target.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, composed: true, cancelable: true }));
    },
    { name, text },
  );
}

test('a CSV column of long values imports as `text`, a column of short ones as `string`', async ({ page }) => {
  const rows = Array.from({ length: 6 }, (_, i) => `open,"${BODY} #${i}"`).join('\n');
  await importCsv(page, 'notes.csv', `status,body\n${rows}\n`);

  // The drop asks whether to review the columns first.
  await page.locator('host-dialogs').getByRole('button', { name: 'Import directly', exact: true }).click();

  const table = await page.evaluate(async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const store = (window as any).__easydb.store;
    let last = null;
    for (let i = 0; i < 60; i++) {
      const all = await store.tables.find();
      const t = all.find((x: { name: string }) => x.name === 'notes');
      // Wait for the RENDERER, not just for the table. `auto-renderer` assigns it
      // in a patch of its own after the import writes the table, so a poll that
      // stopped at "the table exists" read it one write too early — which passed
      // on an idle machine and failed under load.
      if (t) {
        last = t;
        const body = (t.columns as Array<{ field: string; renderer?: string }>).find((c) => c.field === 'body');
        if (body?.renderer) return t;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    // Return what we saw rather than null, so a real regression fails on the
    // renderer assertion below instead of on a bare "table is null".
    return last;
  });
  expect(table).not.toBeNull();
  const byField = Object.fromEntries((table.columns as Array<{ field: string; type: string; renderer?: string }>).map((c) => [c.field, c]));
  expect(byField['status'].type).toBe('string');
  expect(byField['body'].type).toBe('text');
  // Prose gets the preview renderer, as a long untyped column already did.
  expect(byField['body'].renderer).toBe('preview');
});

test('a funnel on a text column offers no value list, but still filters by typing', async ({ page }) => {
  const id = await createTable(page, 'Articles', [{ field: 'title' }, { field: 'body', type: 'text' }]);
  await waitForPanel(page, id);
  await bulkAddRows(page, id, [
    { title: 'one', body: 'alpha prose' },
    { title: 'two', body: 'beta prose' },
    { title: 'three', body: 'alpha prose' },
  ]);

  const panel = page.locator(`#${panelDomId(id)}`);
  const popover = page.locator('filter-popover');

  // Every row on screen before the funnel opens. The funnel offers the values
  // the grid is holding, so opening it early offers none at all.
  await expect(panel.locator('data-table tbody tr:not(.spacer)')).toHaveCount(3);

  // The short `title` column behaves as before: three values, one per row.
  await panel.locator('data-table thead th button.funnel').first().click();
  await expect(popover).toBeVisible();
  await expect(popover.locator('li')).toHaveCount(3);
  await page.keyboard.press('Escape');
  await expect(popover).toBeHidden();

  // The `text` column offers nothing to pick — even though its values are
  // short enough that the length rule alone would have listed them.
  await panel.locator('data-table thead th button.funnel').nth(1).click();
  await expect(popover).toBeVisible();
  await expect(popover.locator('li')).toHaveCount(0);

  // The filter itself still works: prose is filtered by typing, not by picking.
  const funnel = panel.locator('data-table filter-combobox').nth(1);
  await funnel.locator('input').fill('beta');
  await expect(panel.locator('data-table tbody tr')).toHaveCount(1);
});

test('the columns editor offers `text` and keeps it through a save', async ({ page }) => {
  const id = await createTable(page, 'Posts', [{ field: 'body' }]);
  await waitForPanel(page, id);
  await addRow(page, id, { body: 'hello' });

  await page
    .locator(`#${panelDomId(id)}`)
    .locator('panel-footer')
    .getByRole('button', { name: /Columns/ })
    .click();
  const dlg = page.locator('new-table-dialog dialog');
  await expect(dlg).toBeVisible();

  const typeSelect = dlg.locator('.col-row select').first();
  await expect(typeSelect.locator('option[value="text"]')).toHaveCount(1);
  await typeSelect.selectOption('text');
  await dlg.getByRole('button', { name: /Save|Create/ }).click();
  await expect(dlg).toBeHidden();

  await expect.poll(async () => (await readTable(page, id)).columns[0].type).toBe('text');
});
