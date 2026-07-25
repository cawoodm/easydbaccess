import { test, expect } from './fixtures.js';
import { createTable, panelDomId, waitForPanel } from './helpers.js';

/**
 * Datasette column metadata surfaced in the grid header: a column's `units`
 * show as a muted suffix on the label, and its `description` is the header
 * tooltip. (The metadata is applied by applyTableMetadata on import/connect;
 * here we set it directly and assert the header renders it.)
 */
test('column units + description render in the grid header', async ({ page, workspaceId }) => {
  const id = await createTable(page, 'Metrics', [{ field: 'height' }, { field: 'name' }]);
  await waitForPanel(page, id);

  // Set units + description on the "height" column (as import/connect would).
  await page.evaluate(
    async ({ id }) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ctx = (window as any).__easydb;
      const t = await ctx.store.tables.findOne(id);
      const columns = t.columns.map((c: { field: string }) =>
        c.field === 'height' ? { ...c, units: 'm', description: 'How tall it is' } : c,
      );
      await ctx.store.tables.patch(id, { columns, updatedAt: Date.now() });
    },
    { id },
  );

  const th = page.locator(`#${panelDomId(id)} data-table thead th`, { hasText: 'height' });
  await expect(th.locator('.col-units')).toHaveText('(m)');
  await expect(th).toHaveAttribute('title', /How tall it is/);
});

test('a column flagged sortable:false does not sort when its header is clicked', async ({
  page,
  workspaceId,
}) => {
  const id = await createTable(page, 'Locked', [{ field: 'a' }, { field: 'b' }]);
  await waitForPanel(page, id);
  await page.evaluate(
    async ({ id }) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ctx = (window as any).__easydb;
      const t = await ctx.store.tables.findOne(id);
      const columns = t.columns.map((c: { field: string }) =>
        c.field === 'a' ? { ...c, sortable: false } : c,
      );
      await ctx.store.tables.patch(id, { columns, updatedAt: Date.now() });
    },
    { id },
  );

  const th = page.locator(`#${panelDomId(id)} data-table thead th`, { hasText: 'a' });
  await expect(th).toHaveClass(/no-sort/);
  await th.click();
  // No sort was recorded on the table (the click is a no-op for a locked column).
  const sortColumn = await page.evaluate(async (tid) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ctx = (window as any).__easydb;
    return (await ctx.store.tables.findOne(tid)).sortColumn ?? null;
  }, id);
  expect(sortColumn).toBeNull();
});
