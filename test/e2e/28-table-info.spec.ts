import { test, expect } from './fixtures.js';
import { createTable, panelDomId, waitForPanel } from './helpers.js';

/**
 * The window titlebar shows an (i) button when its table carries descriptive
 * metadata (Datasette description / source / license / about). Clicking it opens
 * a read-only info dialog. The button is hidden when there's no such metadata.
 */
test('the (i) info button appears with table metadata and opens the info dialog', async ({
  page,
}) => {
  const id = await createTable(page, 'Attractions', [{ field: 'name' }]);
  await waitForPanel(page, id);

  const infoBtn = page.locator(`#${panelDomId(id)} .eda-info-btn`);
  // Hidden while the table has no info metadata.
  await expect(infoBtn).toBeHidden();

  await page.evaluate(
    async ({ id }) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ctx = (window as any).__easydb;
      await ctx.store.tables.patch(id, {
        info: {
          description: 'Roadside attractions of note.',
          source: 'ACME Data',
          sourceUrl: 'https://acme.example/data',
          license: 'ODbL',
        },
        updatedAt: Date.now(),
      });
    },
    { id },
  );

  await expect(infoBtn).toBeVisible();
  await infoBtn.click();

  const dlg = page.locator('table-info-dialog dialog');
  await expect(dlg).toBeVisible();
  await expect(dlg).toContainText('Roadside attractions of note.');
  await expect(dlg.locator('a', { hasText: 'ACME Data' })).toHaveAttribute(
    'href',
    'https://acme.example/data',
  );
  await expect(dlg).toContainText('ODbL');
});
