import { test, expect, type Page } from './fixtures.js';
import { bulkAddRows, createTable, panelDomId, waitForPanel } from './helpers.js';

/**
 * Shift-clicking a header adds a sort level behind the ones already active, so
 * "city, then age descending" is two clicks. A plain click still replaces the
 * whole sort — one column is the common case.
 *
 * A first click sorts DESCENDING (`grid:sortDescFirst`, on by default — see
 * table/sort-cycle.ts), so the ascending steps below are the SECOND click.
 */

/** The visible cell text per row, in DOM order. */
const gridRows = (page: Page, id: string) =>
  page.evaluate((d) => {
    const dt = document.getElementById(d)!.querySelector('data-table')!;
    return Array.from(dt.shadowRoot!.querySelectorAll('tbody tr:not(.spacer)')).map((tr) =>
      Array.from(tr.querySelectorAll('td')).map((td) => {
        const input = td.querySelector('input');
        return input ? input.value : (td.textContent ?? '').trim();
      }),
    );
  }, panelDomId(id));

test('shift-click adds a second sort key; a plain click replaces the sort', async ({ page }) => {
  const id = await createTable(page, 'People', [
    { field: 'city' },
    { field: 'age', type: 'number' },
  ]);
  await waitForPanel(page, id);
  await bulkAddRows(page, id, [
    { city: 'Bern', age: 30 },
    { city: 'Aarau', age: 40 },
    { city: 'Bern', age: 20 },
    { city: 'Aarau', age: 10 },
  ]);

  const header = (field: string) =>
    page
      .locator(`#${panelDomId(id)} data-table thead th`)
      .filter({ has: page.locator('.col-label', { hasText: new RegExp(`^${field}$`) }) });

  // Primary: city ascending — the second click, since the first is descending.
  await header('city').click();
  await header('city').click();
  await expect.poll(() => gridRows(page, id).then((r) => r.map((c) => c[0]))).toEqual([
    'Aarau',
    'Aarau',
    'Bern',
    'Bern',
  ]);

  // Secondary: age descending, added with shift — city order is kept and the
  // ties inside each city are broken by age.
  await header('age').click({ modifiers: ['Shift'] }); // desc, first click
  await expect
    .poll(() => gridRows(page, id).then((r) => r.map((c) => `${c[0]}:${c[1]}`)))
    .toEqual(['Aarau:40', 'Aarau:10', 'Bern:30', 'Bern:20']);

  // Both keys are stored, in order, and the primary is mirrored onto the legacy
  // single-sort fields so a view window still reads it.
  await expect
    .poll(() =>
      page.evaluate(async (tid) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const t = await (window as any).__easydb.store.tables.findOne(tid);
        return { sortBy: t.sortBy, sortColumn: t.sortColumn, sortAsc: t.sortAsc };
      }, id),
    )
    .toEqual({
      sortBy: [
        { field: 'city', asc: true },
        { field: 'age', asc: false },
      ],
      sortColumn: 'city',
      sortAsc: true,
    });

  // The headers show their priority while two keys are active.
  await expect(header('city').locator('.sort-rank')).toHaveText('1');
  await expect(header('age').locator('.sort-rank')).toHaveText('2');

  // A plain click on age drops the city key: age alone, descending, and no rank
  // numbers because a single key needs none.
  await header('age').click();
  await expect
    .poll(() => gridRows(page, id).then((r) => r.map((c) => c[1])))
    .toEqual(['40', '30', '20', '10']);
  await expect(page.locator(`#${panelDomId(id)} data-table .sort-rank`)).toHaveCount(0);

  // A third click on the same column turns sorting off (desc → asc → off).
  await header('age').click(); // asc
  await header('age').click(); // off
  await expect
    .poll(() =>
      page.evaluate(async (tid) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const t = await (window as any).__easydb.store.tables.findOne(tid);
        return { sortBy: t.sortBy ?? null, sortColumn: t.sortColumn ?? null };
      }, id),
    )
    .toEqual({ sortBy: null, sortColumn: null });
});

test('a workspace with only the old single sort still sorts by it', async ({ page }) => {
  // Written the way pre-multi-sort code did: sortColumn/sortAsc, no sortBy.
  const id = await createTable(page, 'Legacy', [{ field: 'name' }]);
  await waitForPanel(page, id);
  await bulkAddRows(page, id, [{ name: 'c' }, { name: 'a' }, { name: 'b' }]);
  await page.evaluate(async (tid) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (window as any).__easydb.store.tables.patch(tid, {
      sortColumn: 'name',
      sortAsc: false,
      updatedAt: Date.now(),
    });
  }, id);

  await expect.poll(() => gridRows(page, id).then((r) => r.map((c) => c[0]))).toEqual([
    'c',
    'b',
    'a',
  ]);
});
