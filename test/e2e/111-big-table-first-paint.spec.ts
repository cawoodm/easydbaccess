import { test, expect, type Page } from './fixtures.js';
import { createTable, panelDomId, waitForPanel } from './helpers.js';

/**
 * What a BIG table does in the first second of being opened.
 *
 * Four things were wrong, all found on one 609,283-row table:
 *
 * 1. Opening it ran the same page query FOUR times. `bind` ran twice (a panel sets
 *    `tableId` before the element connects, so `connectedCallback` bound and Lit's
 *    first `updated` bound again), and each bind both took the change signal's
 *    immediate load AND started one of its own.
 * 2. Worse, the double bind cost the row COUNT. `countNow` dropped its answer when the
 *    collection it counted was no longer the grid's, and `store.rows(id)` builds a
 *    fresh wrapper per call — so the re-bind always won the race against a 14-second
 *    count, and a big table never learned its own size. Its titlebar kept showing the
 *    page in hand: `(500)` on a table of 609,283 rows.
 * 3. A saved SORT made the first paint wait 20 s. Nothing in IndexedDB can order rows
 *    by a field inside `data`, so a sorted page means reading every row — where the
 *    unsorted page beside it takes 193 ms.
 * 4. A saved FILTER re-read the whole table every five seconds, without end: a
 *    narrowed read measures its matches, so `tableTotal` stayed 0, and the window
 *    decision compared it against a threshold 0 can never reach.
 *
 * The store here is a fake, as in `105-windowed-rows.spec.ts`: real 600,000-row data
 * takes 17 minutes to seed, and these assertions are about which queries the grid
 * ISSUES and what its title says — not about how fast IndexedDB is. It is armed with
 * `addInitScript` so it is in place BEFORE the grid binds, which is what lets a test
 * reload the page and still be talking to it.
 */

const ROWS = 5000;
const THRESHOLD = 1000;

interface Fake {
  queries: Array<{ sort: string; filters: string; limit: number | null; countTotal: unknown }>;
  releaseCount: () => void;
}

/**
 * Arm a fake row collection for every page load from here on: it windows, sorts and
 * filters, and its `count()` does not answer until the test says so — which is what a
 * real 14-second count looks like from the grid's side.
 */
async function armFakeStore(page: Page, opts: { sortMs?: number } = {}) {
  await page.addInitScript(
    ({ n, sortMs }) => {
      /* eslint-disable @typescript-eslint/no-explicit-any */
      const all = Array.from({ length: n }, (_, i) => ({ id: `r${i}`, tableId: '', data: { n: i, name: `row ${i}`, bucket: String(i % 4) }, updatedAt: 1 }));
      let releaseCount = () => {};
      const gate = new Promise<void>((res) => (releaseCount = res as () => void));
      const fake = { queries: [] as unknown[], releaseCount: () => releaseCount() };
      (window as any).__fake = fake;

      // The app context is built after this script runs, so wait for it rather than
      // assume it. Patching after the grid has bound would be too late.
      const tick = () => {
        const ctx = (window as any).__easydb;
        if (!ctx?.store) return void setTimeout(tick, 2);
        const real = ctx.store.rows.bind(ctx.store) as (t: string) => any;
        ctx.store.rows = (tableId: string): any => {
          const base = real(tableId);
          const mine = all.map((r) => ({ ...r, tableId }));
          return {
            ...base,
            count: async () => {
              await gate;
              return mine.length;
            },
            find: () => Promise.resolve(mine),
            query: async (q: any) => {
              fake.queries.push({ sort: q?.sort ? q.sort.map((s: any) => s.field).join(',') : '', filters: JSON.stringify(q?.filters ?? {}), limit: q?.limit ?? null, countTotal: q?.countTotal });
              let rows = mine;
              const active = Object.entries(q?.filters ?? {}).filter(([, v]) => String(v ?? '').trim() !== '');
              if (active.length > 0) rows = rows.filter((r) => active.every(([f, v]) => String((r.data as any)[f]) === String(v)));
              if (q?.sort?.length) {
                // The expensive path, as it is in the real store.
                if (sortMs) await new Promise((res) => setTimeout(res, sortMs));
                const field = q.sort[0].field as string;
                rows = rows.slice().sort((a, b) => ((a.data as any)[field] > (b.data as any)[field] ? 1 : -1));
              }
              const from = q?.offset ?? 0;
              const to = q?.limit != null ? from + q.limit : rows.length;
              // `countTotal: false` is honored, exactly as the Dexie store honors it —
              // that is what leaves the grid with a floor and no total.
              const narrowed = active.length > 0 || q?.sort?.length;
              return { rows: rows.slice(from, to), total: q?.countTotal === false && !narrowed ? -1 : rows.length };
            },
          };
        };
      };
      tick();
      /* eslint-enable @typescript-eslint/no-explicit-any */
    },
    { n: ROWS, sortMs: opts.sortMs ?? 0 },
  );
}

const queries = (page: Page) => page.evaluate(() => (window as unknown as { __fake: Fake }).__fake.queries);
const releaseCount = (page: Page) => page.evaluate(() => (window as unknown as { __fake: Fake }).__fake.releaseCount());
const booted = (page: Page) => page.waitForFunction(() => Boolean((window as unknown as { __easydb?: unknown }).__easydb));

async function setThreshold(page: Page, n: number) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await page.evaluate((v) => (window as any).__easydb.api.settings.set('grid', 'windowRowsFrom', v), n);
}

/**
 * Threshold stored, fake armed, page reloaded — so the grid reads both at connect.
 * Setting the threshold on a live page instead fires a settings-changed event mid-boot,
 * which is a refetch of its own and muddies a query count.
 */
async function bigTablePage(page: Page, opts: { sortMs?: number } = {}) {
  await setThreshold(page, THRESHOLD);
  await armFakeStore(page, opts);
  await page.reload();
  await booted(page);
}

const title = (page: Page, id: string) => page.locator(`#${panelDomId(id)} .panel-title, #${panelDomId(id)} .jsPanel-title`).first();

/**
 * Group a number the way the PAGE would. Node's locale here is Swiss (`5’000`) and the
 * browser's is en-US (`5,000`), so an expectation built in Node fails on a separator
 * nobody chose.
 */
const grouped = (page: Page, n: number) => page.evaluate((v) => v.toLocaleString(), n);

/** Set a saved sort or filter, the way a reopened window would find it. */
async function saveQueryState(page: Page, id: string, patch: Record<string, unknown>) {
  await page.evaluate(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async ({ id, patch }) => void (await (window as any).__easydb.store.tables.patch(id, { ...patch, updatedAt: Date.now() })),
    { id, patch },
  );
}

test('opening a big table does not read its page four times', async ({ page }) => {
  await bigTablePage(page);
  const id = await createTable(page, 'Big', [{ field: 'name' }]);
  await waitForPanel(page, id);
  await expect.poll(async () => (await queries(page)).length).toBeGreaterThan(0);

  // Long enough for every trigger that used to fire to have fired.
  await page.waitForTimeout(1500);
  const pages = (await queries(page)).filter((q) => q.limit === 500);
  // Two, down from four. One bind, and it waits for the load the change signal already
  // started rather than adding its own. The second read is 25 ms behind the first, from
  // a trigger not yet tracked down — far enough apart that sharing the read in flight
  // does not catch it, cheap on a page of 500, and worth one more look than it has had.
  expect(pages.length).toBeLessThanOrEqual(2);
});

test('a saved sort does not hold up the first paint', async ({ page }) => {
  // A sorted read that takes a second and a half, as a real one takes five.
  await bigTablePage(page, { sortMs: 1500 });
  const id = await createTable(page, 'Big', [{ field: 'name' }, { field: 'n', type: 'number' }]);
  await waitForPanel(page, id);
  await saveQueryState(page, id, { sortBy: [{ field: 'n', asc: true }] });

  // Rows are on screen well before the sorted read could have finished.
  const drawn = page.locator(`#${panelDomId(id)} data-table tbody tr:not(.spacer)`);
  await expect.poll(async () => drawn.count(), { timeout: 1200 }).toBeGreaterThan(0);

  // And an unsorted page is what got them there — the sort follows it.
  expect((await queries(page)).some((q) => q.sort === '' && q.limit === 500)).toBe(true);
  await expect.poll(async () => (await queries(page)).some((q) => q.sort === 'n')).toBe(true);
});

test('the title shows a floor, not a total it does not have', async ({ page }) => {
  await bigTablePage(page);
  const id = await createTable(page, 'Big', [{ field: 'name' }]);
  await waitForPanel(page, id);

  // The count is still pending, so the page in hand is all the grid knows. `(500)`
  // here would claim the table HAS 500 rows.
  await expect(title(page, id)).toContainText('…');
  await expect(title(page, id)).not.toHaveText(/\(500\)$/);

  // Once the count lands the title says the table's real size. No `500/5,000`: a slash
  // means a filter narrowed the set, and 500 is a page the user scrolls through, not a
  // match — see `105-windowed-rows.spec.ts`.
  await releaseCount(page);
  await expect(title(page, id)).toHaveText(`Big (${await grouped(page, ROWS)})`);
});

test('the size is remembered, so the next open shows it at once', async ({ page }) => {
  await bigTablePage(page);
  const id = await createTable(page, 'Big', [{ field: 'name' }]);
  await waitForPanel(page, id);
  await releaseCount(page);
  await expect(title(page, id)).toHaveText(`Big (${await grouped(page, ROWS)})`);

  // A fresh page, and a fresh gate with it — nothing will answer `count()` this time.
  await page.reload();
  await booted(page);
  await waitForPanel(page, id);

  // The size is there anyway, remembered from the count that was already paid for.
  // Without it the title would sit on its floor until a 14-second count came back.
  // A generous wait: this one restores a window after a reload, and under a loaded
  // machine the whole boot can take longer than the default five seconds.
  await expect(title(page, id)).toHaveText(`Big (${await grouped(page, ROWS)})`, { timeout: 15_000 });
  await expect(title(page, id)).not.toContainText('…');
});

test('a saved filter does not re-read the table for ever', async ({ page }) => {
  await bigTablePage(page);
  const id = await createTable(page, 'Big', [{ field: 'name' }, { field: 'bucket' }]);
  await waitForPanel(page, id);
  await saveQueryState(page, id, { filters: { bucket: '1' } });
  await expect.poll(async () => (await queries(page)).filter((q) => q.filters.includes('bucket')).length).toBeGreaterThan(0);

  // The count stays pending, which is exactly the state the old loop needed: it was the
  // missing size that kept the window decision unsettled, and every re-read produced
  // the same missing size.
  await page.waitForTimeout(3000);
  const settled = (await queries(page)).filter((q) => q.filters.includes('bucket')).length;
  await page.waitForTimeout(3000);
  expect((await queries(page)).filter((q) => q.filters.includes('bucket')).length).toBe(settled);
  // And it took a handful of reads, not one per second.
  expect(settled).toBeLessThanOrEqual(3);
});
