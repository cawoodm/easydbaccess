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
      const columns = t.columns.map((c: { field: string }) => (c.field === 'height' ? { ...c, units: 'm', description: 'How tall it is' } : c));
      await ctx.store.tables.patch(id, { columns, updatedAt: Date.now() });
    },
    { id },
  );

  const th = page.locator(`#${panelDomId(id)} data-table thead th`, { hasText: 'height' });
  await expect(th.locator('.col-units')).toHaveText('(m)');
  await expect(th).toHaveAttribute('title', /How tall it is/);
});

test('a column flagged sortable:false does not sort when its header is clicked', async ({ page, workspaceId }) => {
  const id = await createTable(page, 'Locked', [{ field: 'a' }, { field: 'b' }]);
  await waitForPanel(page, id);
  await page.evaluate(
    async ({ id }) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ctx = (window as any).__easydb;
      const t = await ctx.store.tables.findOne(id);
      const columns = t.columns.map((c: { field: string }) => (c.field === 'a' ? { ...c, sortable: false } : c));
      await ctx.store.tables.patch(id, { columns, updatedAt: Date.now() });
    },
    { id },
  );

  // Match the label span exactly. Plain `hasText: 'a'` on the <th> also matched
  // column "b", because a header's text includes its icon ligatures and
  // "drag_indicator" contains an "a".
  const th = page.locator(`#${panelDomId(id)} data-table thead th`).filter({ has: page.locator('.col-label', { hasText: /^a$/ }) });
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

test('label_column becomes the default mapping for a view $TITLE token', async ({ page, workspaceId }) => {
  // Table has no "title" column, but designates "headline" as its label column.
  const id = await createTable(page, 'News', [{ field: 'headline' }, { field: 'url' }]);
  await waitForPanel(page, id);
  await page.evaluate(
    async ({ id }) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ctx = (window as any).__easydb;
      await ctx.store.tables.patch(id, { labelColumn: 'headline', updatedAt: Date.now() });
    },
    { id },
  );

  await page
    .locator(`#${panelDomId(id)} panel-footer`)
    .getByRole('button', { name: /Views/ })
    .click();
  const dlg = page.locator('views-dialog dialog');
  await dlg.locator('ul.list li', { hasText: 'RSS Feed' }).getByRole('button', { name: 'Use' }).click();
  await dlg.getByRole('button', { name: 'Create view' }).click();

  // The RSS $TITLE token auto-mapped to the label column (headline), not blank.
  const mapping = await page.evaluate(async (ws) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ctx = (window as any).__easydb;
    const insts = await ctx.store.viewInstances.find({ workspaceId: ws });
    return insts[0]?.mapping ?? {};
  }, workspaceId);
  expect(mapping.TITLE).toBe('headline');
});
