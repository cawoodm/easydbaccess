import type { Page } from '@playwright/test';
import { test, expect } from './fixtures.js';
import { bulkAddRows, createTable, panelDomId, waitForPanel } from './helpers.js';

/**
 * Dragging a column header from one table's grid onto another table's window
 * opens the projection editor with both tables already joined and that one
 * column selected.
 *
 * The same drag REORDERS a column when it lands back on its own grid, so the
 * gesture means two things and the drop target is what tells them apart. Both
 * are covered here.
 */

/**
 * Drag a column header out of one grid and drop it on another table's window.
 *
 * Synthesised rather than driven with the mouse: the grip lives in `data-table`'s
 * shadow root and Playwright's `dragTo` cannot carry one `DataTransfer` across
 * the two shadow trees, which is the whole mechanism under test. `composed: true`
 * is what lets the document-level listener in `app-shell` see it at all.
 */
async function dragColumnOnto(page: Page, from: { tableId: string; colIndex: number }, toTableId: string | null) {
  return page.evaluate(
    ({ from, toTableId }) => {
      const grid = document.querySelector(`#panel-${from.tableId} data-table`);
      const grip = grid?.shadowRoot?.querySelectorAll('thead th .col-grip')[from.colIndex] as HTMLElement | undefined;
      if (!grip) throw new Error('no column grip found');
      const dataTransfer = new DataTransfer();
      grip.dispatchEvent(new DragEvent('dragstart', { dataTransfer, bubbles: true, composed: true }));
      // No table id ⇒ the empty canvas, which for a drop is just the document.
      const target = toTableId ? document.querySelector(`#panel-${toTableId} data-table`) : document.body;
      if (!target) throw new Error('no drop target found');
      target.dispatchEvent(new DragEvent('dragover', { dataTransfer, bubbles: true, composed: true, cancelable: true }));
      target.dispatchEvent(new DragEvent('drop', { dataTransfer, bubbles: true, composed: true, cancelable: true }));
    },
    { from, toTableId },
  );
}

async function seed(page: Page) {
  const people = await createTable(page, 'People', [{ field: 'name' }, { field: 'deptId' }]);
  await waitForPanel(page, people);
  const dept = await createTable(page, 'Dept', [{ field: 'deptId' }, { field: 'label' }]);
  await waitForPanel(page, dept);
  await bulkAddRows(page, people, [
    { name: 'Bob', deptId: 'd1' },
    { name: 'Ann', deptId: 'd2' },
  ]);
  await bulkAddRows(page, dept, [
    { deptId: 'd1', label: 'Sales' },
    { deptId: 'd2', label: 'Support' },
  ]);
  return { people, dept };
}

const projDialog = (page: Page) => page.locator('projection-dialog dialog');

test('a column dropped on another table opens the projection editor, joined', async ({ page }) => {
  const { people, dept } = await seed(page);

  // Drag Dept's `label` (column 1) onto the People window.
  await dragColumnOnto(page, { tableId: dept, colIndex: 1 }, people);

  // No filters anywhere, so nothing is asked — straight to the editor.
  await expect(projDialog(page)).toBeVisible();
  // The drop target is the BASE and the column's own table is joined onto it.
  await expect(projDialog(page)).toContainText('People');
  await expect(projDialog(page)).toContainText('Dept');

  await projDialog(page).getByRole('button', { name: 'Save', exact: true }).click();
  await expect(projDialog(page)).toBeHidden();

  // Two sources, and only the dragged column came across from the second.
  const spec = await page.evaluate(async () => {
    /* eslint-disable @typescript-eslint/no-explicit-any */
    const ctx = (window as any).__easydb;
    const all = await ctx.store.tables.find({ workspaceId: ctx.workspaceId });
    const proj = all.find((t: any) => t.source?.type === 'projection');
    return proj?.source?.config ?? null;
    /* eslint-enable @typescript-eslint/no-explicit-any */
  });
  expect(spec).not.toBeNull();
  expect(spec.sources.map((s: { tableName: string }) => s.tableName)).toEqual(['People', 'Dept']);
  const fromSecond = spec.columns.filter((c: { from: { alias?: string } }) => c.from.alias === spec.sources[1].alias);
  expect(fromSecond).toHaveLength(1);
  expect(fromSecond[0].from.field).toBe('label');
});

test('the drop asks whether to carry the filters across', async ({ page }) => {
  const { people, dept } = await seed(page);

  // Filter the grid the column is dragged FROM; the filter travels with the drag.
  const funnel = page.locator(`#${panelDomId(dept)} data-table filter-combobox`).first();
  await funnel.locator('input').fill('d1');
  await expect(page.locator(`#${panelDomId(dept)} data-table tbody tr`)).toHaveCount(1);

  await dragColumnOnto(page, { tableId: dept, colIndex: 1 }, people);

  const host = page.locator('host-dialogs');
  await expect(host.getByRole('button', { name: 'Keep the filters', exact: true })).toBeVisible();
  await host.getByRole('button', { name: 'Keep the filters', exact: true }).click();

  await expect(projDialog(page)).toBeVisible();
  await projDialog(page).getByRole('button', { name: 'Save', exact: true }).click();
  await expect(projDialog(page)).toBeHidden();

  const spec = await page.evaluate(async () => {
    /* eslint-disable @typescript-eslint/no-explicit-any */
    const ctx = (window as any).__easydb;
    const all = await ctx.store.tables.find({ workspaceId: ctx.workspaceId });
    return all.find((t: any) => t.source?.type === 'projection')?.source?.config ?? null;
    /* eslint-enable @typescript-eslint/no-explicit-any */
  });
  expect(spec.filters).toMatchObject({ deptId: 'd1' });
});

test('"All data" leaves the projection unfiltered', async ({ page }) => {
  const { people, dept } = await seed(page);
  const funnel = page.locator(`#${panelDomId(dept)} data-table filter-combobox`).first();
  await funnel.locator('input').fill('d1');
  await expect(page.locator(`#${panelDomId(dept)} data-table tbody tr`)).toHaveCount(1);

  await dragColumnOnto(page, { tableId: dept, colIndex: 1 }, people);
  await page.locator('host-dialogs').getByRole('button', { name: 'All data', exact: true }).click();

  await expect(projDialog(page)).toBeVisible();
  await projDialog(page).getByRole('button', { name: 'Save', exact: true }).click();
  await expect(projDialog(page)).toBeHidden();

  const spec = await page.evaluate(async () => {
    /* eslint-disable @typescript-eslint/no-explicit-any */
    const ctx = (window as any).__easydb;
    const all = await ctx.store.tables.find({ workspaceId: ctx.workspaceId });
    return all.find((t: any) => t.source?.type === 'projection')?.source?.config ?? null;
    /* eslint-enable @typescript-eslint/no-explicit-any */
  });
  expect(spec.filters).toBeUndefined();
});

test('a column dropped back on its own grid still just reorders it', async ({ page }) => {
  // The gesture is overloaded, so the drop target has to keep the two apart —
  // a reorder must not start offering to build a projection of a table with
  // itself.
  const { dept } = await seed(page);

  await dragColumnOnto(page, { tableId: dept, colIndex: 1 }, dept);

  await expect(projDialog(page)).toBeHidden();
  await expect(page.locator('host-dialogs dialog[open]')).toHaveCount(0);
});

test('a column dropped on the canvas does nothing', async ({ page }) => {
  const { dept } = await seed(page);
  await dragColumnOnto(page, { tableId: dept, colIndex: 1 }, null);
  await expect(projDialog(page)).toBeHidden();
  await expect(page.locator('host-dialogs dialog[open]')).toHaveCount(0);
});
