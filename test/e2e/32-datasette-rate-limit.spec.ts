import { test, expect } from './fixtures.js';

/**
 * When a Datasette import is rate-limited PART-WAY through paging, the rows that
 * already loaded must still land and display — not be discarded, leaving the
 * user with an empty table. Page 1 succeeds (with a `next` token); the page-2
 * hop returns HTTP 429. The import keeps page 1's rows and warns that it stopped
 * early.
 */
const PAGE1 = {
  ok: true,
  next: '100', // more rows available → the importer will try page 2
  truncated: false,
  columns: ['id', 'name', 'capacity_mw'],
  rows: [
    { id: 1, name: 'Kajaki Hydro', capacity_mw: 33 },
    { id: 2, name: 'Kandahar Solar', capacity_mw: 10 },
  ],
};

const json = (body: unknown) => ({
  status: 200,
  contentType: 'application/json',
  headers: { 'access-control-allow-origin': '*' },
  body: JSON.stringify(body),
});

const rateLimited = () => ({
  status: 429,
  contentType: 'application/json',
  headers: { 'access-control-allow-origin': '*' },
  body: JSON.stringify({ ok: false, error: 'rate limit exceeded' }),
});

test('a rate-limited import keeps and displays the rows that loaded before the 429', async ({
  page,
  workspaceId,
}) => {
  await page.route('https://ppl.example/**', (route) => {
    const u = new URL(route.request().url());
    if (u.pathname === '/energy/plants.json') {
      // Page 1 (no _next) succeeds; the page-2 hop (_next=…) is rate-limited.
      return route.fulfill(u.searchParams.get('_next') ? rateLimited() : json(PAGE1));
    }
    if (u.pathname === '/-/metadata.json') return route.fulfill(json({}));
    return route.fulfill({ status: 404, body: '{"ok":false}' });
  });

  // A single-table URL imports straight away (no picker).
  await page.getByTitle('Import data from a URL').click();
  const importDialog = page.locator('import-dialog dialog');
  await expect(importDialog).toBeVisible();
  await importDialog.locator('input[type="text"]').fill('https://ppl.example/energy/plants');
  await importDialog.getByTestId('import-format').selectOption('datasette');
  await importDialog.getByRole('button', { name: 'Import' }).click();

  // Since v0.0.208 a stalled page ASKS instead of giving up silently: wait and
  // resume from that page, or cancel and keep what arrived. Cancel is this
  // test's subject — the rows already fetched must survive it.
  // `button.choice` is the option list — the dialog also has its own dismiss
  // Cancel, so an unscoped name match hits two buttons.
  const paused = page.locator('host-dialogs dialog', { hasText: 'Import paused' });
  await expect(paused).toBeVisible();
  await paused.locator('button.choice', { hasText: 'Cancel' }).click();

  // The two rows from page 1 land locally despite the page-2 rate limit — the
  // table is NOT left empty.
  await expect
    .poll(
      () =>
        page.evaluate(async (ws) => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const store = (window as any).__easydb.store;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const t = (await store.tables.find()).find(
            (x: { workspaceId: string; name: string }) =>
              x.workspaceId === ws && x.name === 'energy/plants',
          );
          if (!t) return -1;
          return (await store.rows(t.id).find()).length;
        }, workspaceId),
      { timeout: 15_000 },
    )
    .toBe(2);

  // A warning explains the import stopped early (rate limited), so the empty
  // rest of the table isn't mistaken for the whole story.
  await expect(page.getByText(/loaded partially/i)).toBeVisible();

  // The rows are actually rendered in the table grid, not just stored.
  const grid = page.locator('data-table').first();
  await expect(grid.locator('tbody tr')).toHaveCount(2);
});
