import { test, expect, type Page } from './fixtures.js';
import { bulkAddRows, createTable, panelDomId, waitForPanel } from './helpers.js';

/**
 * A cell's surrounding whitespace is part of the cell — on BOTH filter paths.
 *
 * A small table is filtered in memory by `matchesColumnFilter`; a table past the
 * windowing threshold is filtered by SQL (`filter-sql.ts` → the sqlite-wasm
 * worker). The SQL half used to compare `LOWER(TRIM(v))` for every text test, so
 * `" Bern "` satisfied `^Bern` there and failed it in memory.
 *
 * The grid re-filters what comes back before painting, so the visible rows never
 * showed it. **The COUNT did**: a windowed grid reported "3 matching" and drew 2,
 * and the funnel and the truncation note read from that same count. Hence the
 * windowed test asserts `matchingTotal`, not the number of `<tr>`s — asserting
 * rows alone would have passed against the bug.
 */

/** Rows that differ only in their padding, plus one clean control. */
const CITIES = [{ city: ' Bern ' }, { city: 'Bern' }, { city: 'Bernina' }, { city: 'Zurich' }];

/**
 * What the grid must answer for each filter. The matcher is the specification,
 * so these are its answers: `^` and `=` are pinned to the cell as written and so
 * miss the padded one, while a substring is indifferent to the padding.
 */
const EXPECTED: Array<[filter: string, count: number]> = [
  // The reported bug. " Bern " starts with a SPACE, so it is not `^Bern`.
  ['^Bern', 2], // Bern, Bernina
  ['=Bern', 1], // only the unpadded one
  ['Bern', 3], // substring — all three
  ['*Bern*', 3],
  ['*Bern', 1], // ends with it — " Bern " ends with a SPACE, so only "Bern" does
];

const setWindowFrom = (page: Page, v: number) =>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  page.evaluate((n) => (window as any).__easydb.api.settings.set('grid', 'windowRowsFrom', n), v);

const gridState = (page: Page, id: string) =>
  page.evaluate((domId) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const dt = document.getElementById(domId)?.querySelector('data-table') as any;
    return dt ? { held: dt.rows.length as number, matching: dt.matchingTotal as number, windowed: dt.windowed as boolean } : null;
  }, panelDomId(id));

async function seed(page: Page, name: string, extra: Array<{ city: string }> = []) {
  const id = await createTable(page, name, [{ field: 'city' }]);
  await waitForPanel(page, id);
  await bulkAddRows(page, id, [...CITIES, ...extra]);
  const panel = page.locator(`#${panelDomId(id)}`);
  return { id, box: panel.locator('data-table thead filter-combobox input').first(), rows: panel.locator('data-table tbody tr:not(.spacer)') };
}

test('a padded cell filters the same in memory', async ({ page }) => {
  // 0 = never window, so every filter runs through `matchesColumnFilter` and the
  // rows on screen ARE the answer.
  await setWindowFrom(page, 0);
  const { rows, box } = await seed(page, 'CitiesMemory');
  await expect(rows).toHaveCount(CITIES.length);

  for (const [filter, count] of EXPECTED) {
    await box.fill(filter);
    await expect(rows, filter).toHaveCount(count);
  }
});

test('a padded cell filters the same through SQL', async ({ page }) => {
  test.slow();
  // 1 = window from the first row, but the grid only really windows once a page
  // comes back FULL — a short first page means the whole answer is in hand. So
  // the table has to be bigger than one page (500) for the filter to be pushed
  // down to SQLite at all.
  await setWindowFrom(page, 1);
  const filler = Array.from({ length: 600 }, (_, i) => ({ city: `filler ${i}` }));
  const { id, rows, box } = await seed(page, 'CitiesSql', filler);

  await expect.poll(async () => (await gridState(page, id))?.held ?? 0, { timeout: 30_000 }).toBeGreaterThan(0);
  // The filter is only in SQL if this grid is genuinely paging.
  expect((await gridState(page, id))?.windowed).toBe(true);

  for (const [filter, count] of EXPECTED) {
    await box.fill(filter);
    // The COUNT is what SQL answered — the assertion that fails against the bug.
    await expect.poll(async () => (await gridState(page, id))?.matching, { timeout: 15_000 }).toBe(count);
    await expect(rows, filter).toHaveCount(count);
  }

  // The negation over the whole table, which only agrees if the positive did.
  await box.fill('!^Bern');
  await expect.poll(async () => (await gridState(page, id))?.matching, { timeout: 15_000 }).toBe(CITIES.length + filler.length - 2);
});
