import { test, expect } from './fixtures.js';
import { bulkAddRows, createTable, panelDomId, waitForPanel } from './helpers.js';

/**
 * A column narrower than its content shows an ellipsis, so the full value has to
 * be readable on hover: every non-empty cell carries it as its `title`.
 */
const LONG =
  'Kajaki Hydroelectric Power Plant, Helmand — refurbished turbine hall and spillway works';

test('a cell carries its full value as a tooltip', async ({ page }) => {
  const id = await createTable(page, 'Plants', [
    { field: 'name' },
    { field: 'note' },
    { field: 'computed' },
  ]);
  await waitForPanel(page, id);
  await bulkAddRows(page, id, [{ name: LONG, note: '', computed: 'ignored' }]);

  // A scripted column shows a computed value, so its stored value would explain
  // nothing — it gets no tooltip.
  await page.evaluate(async (tid) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const store = (window as any).__easydb.store;
    const t = await store.tables.findOne(tid);
    await store.tables.patch(tid, {
      columns: t.columns.map((c: { field: string }) =>
        c.field === 'computed' ? { ...c, script: 'function render(row) { return "derived" }' } : c,
      ),
      updatedAt: Date.now(),
    });
  }, id);

  const cells = page.locator(`#${panelDomId(id)} data-table tbody tr:not(.spacer) td`);
  // The long value is clipped on screen (the cell is narrower than the text) but
  // present in full on the title.
  await expect(cells.nth(0)).toHaveAttribute('title', LONG);
  await expect
    .poll(() =>
      page.evaluate((d) => {
        const dt = document.getElementById(d)!.querySelector('data-table')!;
        const td = dt.shadowRoot!.querySelector('tbody tr:not(.spacer) td') as HTMLElement;
        const input = td.querySelector('input') as HTMLInputElement | null;
        const el = input ?? td;
        return el.scrollWidth > el.clientWidth;
      }, panelDomId(id)),
    )
    .toBe(true);

  // An empty cell has nothing to show, a scripted one nothing meaningful.
  await expect(cells.nth(1)).toHaveAttribute('title', '');
  await expect(cells.nth(2)).toHaveAttribute('title', '');
});
