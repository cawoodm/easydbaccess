import { test, expect } from './fixtures.js';

/**
 * Importing a .csv file by URL from the Import dialog: the dialog fetches the
 * body and hands it to the CSV importer, creating a typed local table. Network
 * is mocked with page.route.
 */

const CSV = 'city,pop,updated\nBern,133000,2016-01-02\nZug,30000,2016-03-04\n';

test('imports a CSV from a URL into a typed table', async ({ page, workspaceId }) => {
  await page.route('https://ex.example/data.csv', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'text/plain; charset=utf-8',
      headers: { 'access-control-allow-origin': '*' },
      body: CSV,
    }),
  );

  await page.getByTitle('Import data from a URL').click();
  const dlg = page.locator('import-dialog dialog');
  await expect(dlg).toBeVisible();

  // The CSV sample is offered in the dropdown.
  const presetLabels = (await dlg.getByTestId('import-sample').locator('option').allTextContents()).join(' | ').toLowerCase();
  expect(presetLabels).toContain('csv');

  await dlg.locator('input[type="text"]').fill('https://ex.example/data.csv');
  await dlg.getByTestId('import-format').selectOption('csv'); // "Import as: CSV file"
  await dlg.getByRole('button', { name: 'Import', exact: true }).click();

  const summary = await (async () => {
    await expect
      .poll(() =>
        page.evaluate(async (ws) => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const store = (window as any).__easydb.store;
          const t = (await store.tables.find()).find((x: any) => x.workspaceId === ws && x.name === 'data');
          if (!t) return 0;
          return (await store.rows(t.id).find()).length;
        }, workspaceId),
      )
      .toBe(2);

    return page.evaluate(async (ws) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const store = (window as any).__easydb.store;
      const t = (await store.tables.find()).find((x: any) => x.workspaceId === ws && x.name === 'data');
      const cols = Object.fromEntries(t.columns.map((c: { field: string; type: string }) => [c.field, c.type]));
      const rows = await store.rows(t.id).find();
      return { cols, pops: rows.map((r: any) => r.data.pop) };
    }, workspaceId);
  })();

  // Header became columns; types were inferred from the values.
  expect(summary.cols.city).toBe('string');
  expect(summary.cols.pop).toBe('number');
  expect(summary.cols.updated).toBe('date');
  // Values coerced to numbers (not "133000" strings), order-independent.
  expect(summary.pops.every((p: unknown) => typeof p === 'number')).toBe(true);
  expect([...summary.pops].sort((a: number, b: number) => a - b)).toEqual([30000, 133000]);
});

async function attemptCsvImport(page: import('@playwright/test').Page, url: string) {
  await page.getByTitle('Import data from a URL').click();
  const dlg = page.locator('import-dialog dialog');
  await expect(dlg).toBeVisible();
  await dlg.locator('input[type="text"]').fill(url);
  await dlg.getByTestId('import-format').selectOption('csv');
  await dlg.getByRole('button', { name: 'Import', exact: true }).click();
}

test('a CSV import HTTP error surfaces the status code and a body snippet', async ({ page }) => {
  await page.route('https://ex.example/missing.csv', (route) =>
    route.fulfill({
      status: 404,
      contentType: 'text/plain',
      headers: { 'access-control-allow-origin': '*' },
      body: 'Not Found: no such object',
    }),
  );
  await attemptCsvImport(page, 'https://ex.example/missing.csv');
  const toast = page.locator('toast-host .toast.error');
  await expect(toast).toBeVisible();
  await expect(toast).toContainText('404');
  await expect(toast).toContainText('Not Found: no such object');
});

test('an oversized CSV surfaces the actual size and the limit, not "Load failed"', async ({ page }) => {
  // 200 OK with a huge Content-Length (like the 152 MB StackExchange LFS CSV).
  await page.route('https://ex.example/huge.csv', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'text/plain',
      headers: { 'access-control-allow-origin': '*', 'content-length': String(159525875) },
      body: 'a,b\n1,2\n',
    }),
  );
  await attemptCsvImport(page, 'https://ex.example/huge.csv');
  const toast = page.locator('toast-host .toast.error');
  await expect(toast).toBeVisible();
  await expect(toast).toContainText('152.1 MB');
  await expect(toast).toContainText(/limit/i);
});

/**
 * The size ceiling exists because a COPY buffers the body and writes every row
 * to IndexedDB. Two cases do not fit that reasoning and must NOT be refused on
 * total size: a capped import (keeps only a prefix) and a Reference (persists
 * nothing). Both serve a huge Content-Length with a tiny body, so a refusal is
 * distinguishable from a success.
 */
const HUGE_HEADERS = {
  'access-control-allow-origin': '*',
  'content-length': String(159525875), // 152 MB, well over the 50 MB ceiling
};

test('a row limit lifts the size ceiling — an oversized CSV still imports', async ({ page, workspaceId }) => {
  await page.route('https://ex.example/huge-capped.csv', (route) => route.fulfill({ status: 200, contentType: 'text/plain', headers: HUGE_HEADERS, body: CSV }));

  await page.getByTitle('Import data from a URL').click();
  const dlg = page.locator('import-dialog dialog');
  await expect(dlg).toBeVisible();
  await dlg.locator('input[type="text"]').fill('https://ex.example/huge-capped.csv');
  await dlg.getByTestId('import-format').selectOption('csv');
  await dlg.locator('input[type="number"]').fill('1'); // Limit rows
  await dlg.getByRole('button', { name: 'Import', exact: true }).click();

  // It imported (capped to 1 row) instead of being refused for its size.
  await expect
    .poll(async () =>
      page.evaluate(async (ws) => {
        const store = (window as any).__easydb.store;
        const t = (await store.tables.find()).find((x: any) => x.workspaceId === ws && x.name === 'huge-capped');
        if (!t) return -1;
        return (await store.rows(t.id).find()).length;
      }, workspaceId),
    )
    .toBe(1);
  await expect(page.locator('toast-host .toast.error')).toHaveCount(0);
});

test('Reference mode lifts the size ceiling — an oversized CSV is referenced', async ({ page, workspaceId }) => {
  await page.route('https://ex.example/huge-ref.csv', (route) => route.fulfill({ status: 200, contentType: 'text/plain', headers: HUGE_HEADERS, body: CSV }));

  await page.getByTitle('Import data from a URL').click();
  const dlg = page.locator('import-dialog dialog');
  await expect(dlg).toBeVisible();
  await dlg.locator('input[type="text"]').fill('https://ex.example/huge-ref.csv');
  await dlg.getByTestId('import-format').selectOption('csv');
  await dlg.locator('input[type="radio"]').last().check(); // Reference, not Copy
  await dlg.getByRole('button', { name: 'Import', exact: true }).click();

  // A live `url` reference table exists, with columns and no persisted rows.
  // NOTE the name keeps its extension ("huge-ref.csv"): `createUrlReference`
  // uses the raw filename, while a Copy strips it ("huge-ref"). That
  // inconsistency is pre-existing and is matched loosely here rather than
  // asserted, since Phase C's one naming policy will settle it.
  await expect
    .poll(async () =>
      page.evaluate(async (ws) => {
        const store = (window as any).__easydb.store;
        const t = (await store.tables.find()).find((x: any) => x.workspaceId === ws && String(x.name).startsWith('huge-ref'));
        return t ? `${t.source?.type}:${t.columns.length}` : 'missing';
      }, workspaceId),
    )
    .toBe('url:3');
  await expect(page.locator('toast-host .toast.error')).toHaveCount(0);
});

test('a network/CORS failure surfaces a reason, not a bare "Load failed"', async ({ page }) => {
  await page.route('https://ex.example/blocked.csv', (route) => route.abort('failed'));
  await attemptCsvImport(page, 'https://ex.example/blocked.csv');
  const toast = page.locator('toast-host .toast.error');
  await expect(toast).toBeVisible();
  await expect(toast).toContainText('ex.example');
  await expect(toast).toContainText(/no response|CORS|unreachable/i);
});

test('shows the top progress bar when a URL read takes more than 2s', async ({ page, workspaceId }) => {
  // Stall the response ~3s — longer than the 2s slow-threshold — so the top
  // progress bar is revealed while the body is still being read.
  await page.route('https://ex.example/slow.csv', async (route) => {
    await new Promise((r) => setTimeout(r, 3000));
    await route.fulfill({
      status: 200,
      contentType: 'text/plain; charset=utf-8',
      headers: { 'access-control-allow-origin': '*' },
      body: CSV,
    });
  });

  await page.getByTitle('Import data from a URL').click();
  const dlg = page.locator('import-dialog dialog');
  await expect(dlg).toBeVisible();
  await dlg.locator('input[type="text"]').fill('https://ex.example/slow.csv');
  await dlg.getByTestId('import-format').selectOption('csv');
  await dlg.getByRole('button', { name: 'Import', exact: true }).click();

  // The bar (role=progressbar, rendered only while visible) appears once the
  // 2s threshold passes, then disappears once the read completes.
  const bar = page.locator('top-progress').getByRole('progressbar');
  await expect(bar).toBeVisible({ timeout: 8000 });
  await expect(bar).toBeHidden({ timeout: 8000 });

  // And the import still completed.
  await expect
    .poll(() =>
      page.evaluate(async (ws) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const store = (window as any).__easydb.store;
        const t = (await store.tables.find()).find(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (x: any) => x.workspaceId === ws && x.name === 'slow',
        );
        if (!t) return 0;
        return (await store.rows(t.id).find()).length;
      }, workspaceId),
    )
    .toBe(2);
});

/**
 * GitHub serves an LFS-tracked file from the raw host as a ~130-byte pointer
 * stub, HTTP 200, with nothing to say it is not the data. The real bytes live on
 * media.githubusercontent.com, which 404s for files that are NOT LFS-tracked —
 * so the media host is only tried once a pointer has actually come back.
 */
const LFS_POINTER = 'version https://git-lfs.github.com/spec/v1\n' + 'oid sha256:2d1f65308877282edfb4470520eabbc08cb499118432a3dcec6a66c086aa2baa\n' + 'size 140893245\n';

const RAW_LFS = 'https://raw.githubusercontent.com/StackExchange/Survey/main/lfs.csv';
const MEDIA_LFS = 'https://media.githubusercontent.com/media/StackExchange/Survey/main/lfs.csv';
const BLOB_LFS = 'https://github.com/StackExchange/Survey/blob/main/lfs.csv';

/** Column fields of an imported table, joined — '' when the table is absent. */
async function columnFields(page: import('@playwright/test').Page, ws: string, name: string) {
  return page.evaluate(
    async ([w, n]) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const store = (window as any).__easydb.store;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const t = (await store.tables.find()).find((x: any) => x.workspaceId === w && x.name === n);
      if (!t) return '';
      return t.columns.map((c: { field: string }) => c.field).join(',');
    },
    [ws, name],
  );
}

test('an LFS pointer from the raw host is followed to the media host', async ({ page, workspaceId }) => {
  await page.route(RAW_LFS, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'text/plain',
      headers: { 'access-control-allow-origin': '*' },
      body: LFS_POINTER,
    }),
  );
  await page.route(MEDIA_LFS, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'text/plain',
      headers: { 'access-control-allow-origin': '*' },
      body: 'city,pop\nBern,133000\nZug,30000\n',
    }),
  );

  await attemptCsvImport(page, BLOB_LFS);

  // Assert on the COLUMNS, not the row count: parsing the 3-line pointer as CSV
  // also yields 2 rows, so a row count cannot tell the stub from the data. The
  // header must come from the media body.
  await expect.poll(() => columnFields(page, workspaceId, 'lfs')).toBe('city,pop');
});

test('the size limit applies to the media host, not just the first read', async ({ page }) => {
  await page.route(RAW_LFS, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'text/plain',
      headers: { 'access-control-allow-origin': '*' },
      body: LFS_POINTER,
    }),
  );
  // The real StackExchange 2025 survey CSV is 134 MB — over the import limit.
  await page.route(MEDIA_LFS, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'text/plain',
      headers: { 'access-control-allow-origin': '*', 'content-length': String(140893245) },
      body: 'a,b\n1,2\n',
    }),
  );

  await attemptCsvImport(page, BLOB_LFS);
  const toast = page.locator('toast-host .toast.error');
  await expect(toast).toBeVisible();
  await expect(toast).toContainText('134.4 MB');
  await expect(toast).toContainText(/limit/i);
});

test('a github.com blob/raw URL is auto-converted to the CORS raw host and imports', async ({ page, workspaceId }) => {
  // Only the raw.githubusercontent.com URL is served (CORS-enabled). If the app
  // fetched github.com directly it would 404 here → the import would fail.
  await page.route('https://raw.githubusercontent.com/StackExchange/Survey/main/results.csv', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'text/plain',
      headers: { 'access-control-allow-origin': '*' },
      body: 'a,b\n1,2\n3,4\n',
    }),
  );

  await attemptCsvImport(page, 'https://github.com/StackExchange/Survey/raw/refs/heads/main/results.csv');

  await expect
    .poll(() =>
      page.evaluate(async (ws) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const store = (window as any).__easydb.store;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const t = (await store.tables.find()).find((x: any) => x.workspaceId === ws && x.name === 'results');
        if (!t) return 0;
        return (await store.rows(t.id).find()).length;
      }, workspaceId),
    )
    .toBe(2);
});
