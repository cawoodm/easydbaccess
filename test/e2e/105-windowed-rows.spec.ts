import { test, expect } from './fixtures.js';
import { createTable, panelDomId, waitForPanel } from './helpers.js';

/**
 * A big table is read one PAGE at a time instead of being held whole.
 *
 * Measured on one 609,283-row table: 1483 ms and a 15.4 MB payload to put about
 * thirty rows on screen, where the same query for 200 rows takes 13 ms. The grid
 * already virtualised what it DREW; the fetch was what stayed eager.
 *
 * Dexie implements no `query`, so in the browser nothing windows — that is phase
 * 2. To test the grid's half here, the row collection is replaced by one that
 * answers a query and reports a large count, which is what the Electron SQLite
 * store does. The assertions are about what the grid ASKS for and what it draws.
 */

const ROWS = 5000;
const THRESHOLD = 1000;

/**
 * Replace `store.rows(id)` with a collection that answers `count` and `query`
 * over generated rows, and record every query it is asked. Must run BEFORE the
 * table exists, since the grid resolves its collection once, when it binds.
 */
async function installFakeStore(page: import('@playwright/test').Page, rows: number) {
  await page.evaluate((n) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ctx = (window as any).__easydb;
    const all = Array.from({ length: n }, (_, i) => ({ id: `r${i}`, tableId: '', data: { n: i, name: `row ${i}` }, updatedAt: 1 }));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const queries: any[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).__windowQueries = queries;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const real = ctx.store.rows.bind(ctx.store) as (t: string) => any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ctx.store.rows = (tableId: string): any => {
      const base = real(tableId);
      const mine = all.map((r) => ({ ...r, tableId }));
      return {
        ...base,
        count: () => Promise.resolve(mine.length),
        find: () => Promise.resolve(mine),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        query: (q: any) => {
          queries.push(q);
          const from = q?.offset ?? 0;
          const to = q?.limit != null ? from + q.limit : mine.length;
          return Promise.resolve({ rows: mine.slice(from, to), total: mine.length });
        },
        subscribe: (fn: (r: unknown[]) => void) => {
          fn(mine);
          return () => {};
        },
      };
    };
  }, rows);
}

const lastQuery = (page: import('@playwright/test').Page) =>
  page.evaluate(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const qs = (window as any).__windowQueries as any[];
    return qs.length ? qs[qs.length - 1] : null;
  });

const firstQuery = (page: import('@playwright/test').Page) =>
  page.evaluate(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const qs = (window as any).__windowQueries as any[];
    return qs.length ? qs[0] : null;
  });

async function setThreshold(page: import('@playwright/test').Page, n: number) {
  await page.evaluate(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (v) => (window as any).__easydb.api.settings.set('grid', 'windowRowsFrom', v),
    n,
  );
}

test('a table over the threshold is read one page at a time', async ({ page }) => {
  await setThreshold(page, THRESHOLD);
  await installFakeStore(page, ROWS);
  const id = await createTable(page, 'Big', [{ field: 'name' }]);
  await waitForPanel(page, id);

  // The FIRST read is a page, not the table — reading the threshold a moment late
  // would mean paying for the whole-table read once and then correcting it.
  await expect.poll(async () => (await lastQuery(page))?.limit ?? null).not.toBeNull();
  const first = await lastQuery(page);
  expect(first.offset).toBe(0);
  expect(first.limit).toBe(500);

  // The panel title counts the MATCH, not the page — the user reaches every row
  // by scrolling, and "500 of 5000" would read as a filter nobody applied.
  //
  // Grouped, and grouped by the PAGE's locale: Node's is Swiss here (`5’000`) while the
  // browser's is en-US (`5,000`), so the expectation has to be built in the browser.
  const grouped = await page.evaluate((v) => v.toLocaleString(), ROWS);
  await expect(page.locator(`#${panelDomId(id)} .panel-title, #${panelDomId(id)} .jsPanel-title`).first()).toContainText(grouped);

  // Only the visible slice is in the DOM.
  const drawn = page.locator(`#${panelDomId(id)} data-table tbody tr:not(.spacer)`);
  expect(await drawn.count()).toBeLessThan(200);
  // An editable string cell IS an input, so its value is where the text lives.
  await expect(drawn.first().locator('input').first()).toHaveValue('row 0');
});

test('scrolling down asks for the next page', async ({ page }) => {
  await setThreshold(page, THRESHOLD);
  await installFakeStore(page, ROWS);
  const id = await createTable(page, 'Big', [{ field: 'name' }]);
  await waitForPanel(page, id);
  await expect.poll(async () => (await lastQuery(page))?.limit ?? null).not.toBeNull();

  const grid = page.locator(`#${panelDomId(id)} data-table`);
  await grid.evaluate((el) => {
    el.scrollTop = 2000 * 28;
  });

  // A page whose offset covers the rows now on screen, and rows to match. Which
  // exact row lands at the top depends on the measured row height, so the check is
  // that the grid is deep in the table rather than still showing the first page.
  await expect.poll(async () => (await lastQuery(page))?.offset ?? 0, { timeout: 5000 }).toBeGreaterThan(1000);
  const top = await grid.locator('tbody tr:not(.spacer) input').first().inputValue();
  expect(Number(top.replace('row ', ''))).toBeGreaterThan(1500);
});

test('under the threshold the grid settles on holding the table whole', async ({ page }) => {
  // The whole point of a threshold — a table that works well today keeps the code
  // path it has.
  //
  // It gets there in two steps now, and deliberately. Nothing knows how big a table
  // is until something counts it, and counting is not free: in IndexedDB it is a
  // second walk of the index, 730 ms per 100,000 rows, which a 609,283-row table
  // used to pay TWICE before drawing a row. So the first read is speculatively a
  // page — enough to paint — and the size that follows decides the shape. Under the
  // threshold that means one more read, of a table small enough for the read to be
  // cheap by definition.
  await setThreshold(page, ROWS * 10);
  await installFakeStore(page, ROWS);
  const id = await createTable(page, 'Small', [{ field: 'name' }]);
  await waitForPanel(page, id);

  // No PAGE — no offset, and the limit that does travel is the read cap rather
  // than a window. The cap bounds what any read brings back, whoever narrowed
  // it: a filter matching most of a 600k-row table is answerable in SQL, and
  // without the cap on that path the whole match would land in the grid. A cap
  // of 20,000 over a table of 5,000 changes no answer.
  await expect.poll(async () => (await lastQuery(page))?.limit, { timeout: 5000 }).toBe(20_000);
  expect((await lastQuery(page)).offset).toBeUndefined();
});

test('the first read of an unmeasured table is a page, and asks for no count', async ({ page }) => {
  // The rows come first and the total follows. `countTotal: false` is what says so:
  // a store that has to walk an index to count must not make the paint wait for it.
  await setThreshold(page, THRESHOLD);
  await installFakeStore(page, ROWS);
  const id = await createTable(page, 'Big', [{ field: 'name' }]);
  await waitForPanel(page, id);

  await expect.poll(async () => (await firstQuery(page))?.limit ?? null).not.toBeNull();
  const first = await firstQuery(page);
  expect(first.limit).toBe(500);
  expect(first.countTotal).toBe(false);
});

test('0 means never window', async ({ page }) => {
  await setThreshold(page, 0);
  await installFakeStore(page, ROWS);
  const id = await createTable(page, 'Unwindowed', [{ field: 'name' }]);
  await waitForPanel(page, id);

  await expect.poll(async () => (await lastQuery(page)) !== null).toBe(true);
  expect((await lastQuery(page)).offset).toBeUndefined();
});
