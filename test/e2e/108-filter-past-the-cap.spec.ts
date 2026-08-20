import { test, expect } from './fixtures.js';
import { panelDomId, waitForPanel } from './helpers.js';

/**
 * A filter on a table past the read cap must cover the WHOLE table.
 *
 * The cap used to be applied first, so the grid answered "these of the first
 * 20,000" to a question about the table: a row matching at 20,000 was simply
 * absent, and nothing on screen said the filter had only seen part of the data.
 * That is the one failure `truncated` cannot rescue — the answer is not a superset
 * of the right one, it is a different one.
 *
 * The cap now bounds what comes BACK. It cuts a result of more than 20,000 rows,
 * and says so.
 */

const CAP = 20_000;
/** Two past the cap, so a filter that keeps everything but one row still overflows it. */
const ROWS = CAP + 2;

/** A table of `rows` rows where only the LAST one carries `kind = rare`. */
async function seed(page: import('@playwright/test').Page, ws: string, rows: number) {
  return page.evaluate(
    async ({ ws, rows }) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const store = (window as any).__easydb.store;
      const tableId = crypto.randomUUID();
      await store.tables.insert({
        id: tableId,
        workspaceId: ws,
        name: 'Huge',
        code: 'huge',
        columns: [
          { field: 'name', label: 'Name', type: 'string' },
          { field: 'kind', label: 'Kind', type: 'string' },
        ],
        view: 'table',
        updatedAt: Date.now(),
      });
      await store.rows(tableId).bulkInsert(
        Array.from({ length: rows }, (_, i) => ({
          id: crypto.randomUUID(),
          tableId,
          data: { name: `row ${i}`, kind: i === rows - 1 ? 'rare' : 'common' },
          updatedAt: 1,
        })),
      );
      return tableId;
    },
    { ws, rows },
  );
}

const setFilter = (page: import('@playwright/test').Page, id: string, expr: string) =>
  page.evaluate(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async ({ tid, expr }) => (window as any).__easydb.store.tables.patch(tid, { filters: { kind: expr }, updatedAt: Date.now() }),
    { tid: id, expr },
  );

const gridState = (page: import('@playwright/test').Page, id: string) =>
  page.evaluate((domId) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const dt = document.getElementById(domId)?.querySelector('data-table') as any;
    return dt ? { held: dt.rows.length, matching: dt.matchingTotal, truncated: dt.truncated } : null;
  }, panelDomId(id));

test('a value in the last row of a 20k+ table is still found', async ({ page, workspaceId }) => {
  // Writing 20 002 rows is most of the default budget on its own. The work is the
  // point of the test and the budget is not.
  test.slow();
  const id = await seed(page, workspaceId, ROWS);
  await waitForPanel(page, id);
  await expect.poll(async () => (await gridState(page, id))?.held ?? 0, { timeout: 30_000 }).toBeGreaterThan(0);

  await setFilter(page, id, '=rare');

  // One match, out of a table the read cap cannot hold in full.
  await expect.poll(async () => (await gridState(page, id))?.matching, { timeout: 15_000 }).toBe(1);
  const state = await gridState(page, id);
  expect(state?.held).toBe(1);
  // Nothing was cut, so nothing claims it was.
  expect(state?.truncated).toBe(false);

  const drawn = page.locator(`#${panelDomId(id)} data-table tbody tr:not(.spacer):visible`);
  await expect(drawn).toHaveCount(1);
  await expect(drawn.first().locator('input').first()).toHaveValue(`row ${ROWS - 1}`);
});

test('a result bigger than the cap is cut, and the count is the real one', async ({ page, workspaceId }) => {
  test.slow();
  const id = await seed(page, workspaceId, ROWS);
  await waitForPanel(page, id);
  await expect.poll(async () => (await gridState(page, id))?.held ?? 0, { timeout: 30_000 }).toBeGreaterThan(0);

  await setFilter(page, id, '=common');

  // The matching count is what says the filter ran: unfiltered it is every row.
  await expect.poll(async () => (await gridState(page, id))?.matching, { timeout: 15_000 }).toBe(ROWS - 1);
  const state = await gridState(page, id);
  // Cut to the cap, and every match counted — which is what lets the note say how
  // many were left out.
  expect(state?.held).toBe(CAP);
  expect(state?.truncated).toBe(true);
});
