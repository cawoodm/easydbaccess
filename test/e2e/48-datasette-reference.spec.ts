import { test, expect } from './fixtures.js';

/**
 * Referencing Datasette, as opposed to importing a copy of it.
 *
 * Two bugs lived here. Referencing a DATABASE url silently took every table in
 * it — the picker Import and Connect both show was never offered. And a
 * reference read exactly one page, so it stopped at the instance's
 * `max_returned_rows` (1000 by default) no matter what `_size` was asked for;
 * the provider now follows Datasette's cursor — a `next_url` when the instance
 * sends one, otherwise the bare `next` token respent as `?_next=`.
 */

const json = (body: unknown) => ({
  status: 200,
  contentType: 'application/json',
  headers: { 'access-control-allow-origin': '*' },
  body: JSON.stringify(body),
});

/** A database listing with two tables, in Datasette's shape. */
const DB_LISTING = {
  database: 'db',
  tables: [
    { name: 'wanted', columns: ['id', 'v'], count: 2, hidden: false },
    { name: 'unwanted', columns: ['id', 'v'], count: 1, hidden: false },
  ],
};

const row = (id: number) => ({ id, v: `v${id}` });

async function routeDatasette(page: import('@playwright/test').Page) {
  await page.route('https://ds.test/**', (route) => {
    const url = new URL(route.request().url());
    const next = url.searchParams.get('_next');
    switch (url.pathname) {
      case '/db.json':
        return route.fulfill(json(DB_LISTING));
      case '/db/wanted.json':
        // Page 1 hands back a cursor; page 2 ends the walk. A single-page read
        // would see only row 1.
        // A TOKEN cursor and no next_url — what datasette.io actually sends.
        return route.fulfill(next ? json({ ok: true, rows: [row(2)], next: null }) : json({ ok: true, rows: [row(1)], next: '1' }));
      case '/db/unwanted.json':
        return route.fulfill(json({ ok: true, rows: [row(9)], next: null }));
      default:
        return route.fulfill({ status: 404, body: '{"ok":false}' });
    }
  });
}

/** Names of every table in the workspace. */
async function tableNames(page: import('@playwright/test').Page, ws: string) {
  return page.evaluate(async (w) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const store = (window as any).__easydb.store;
    return (
      (await store.tables.find())
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .filter((t: any) => t.workspaceId === w)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .map((t: any) => t.name)
        .sort()
    );
  }, ws);
}

async function startReference(page: import('@playwright/test').Page, url: string) {
  await page.getByTitle('Import data from a URL').click();
  const dlg = page.locator('import-dialog dialog');
  await expect(dlg).toBeVisible();
  await dlg.locator('input[type="text"]').first().fill(url);
  await dlg.getByTestId('import-format').selectOption('datasette');
  await dlg.getByRole('radio').nth(1).check(); // Reference
  await dlg.getByRole('button', { name: 'Import', exact: true }).click();
  return dlg;
}

test('referencing a database URL asks which tables, and takes only those', async ({ page, workspaceId }) => {
  await routeDatasette(page);
  await startReference(page, 'https://ds.test/db');

  // The picker Import and Connect use — it was skipped entirely before.
  const picker = page.locator('table-select-dialog dialog');
  await expect(picker).toBeVisible();
  await expect(picker.getByText(/Choose tables to reference from ds\.test\./i)).toBeVisible();

  const items = picker.locator('ul.tables li');
  await expect(items).toHaveCount(2);

  // Take one of the two.
  await items.filter({ hasText: 'unwanted' }).locator('input[type="checkbox"]').uncheck();
  // The confirm button carries the count: "Reference (1)".
  await picker.getByRole('button', { name: /^Reference \(1\)$/ }).click();

  await expect.poll(() => tableNames(page, workspaceId)).toEqual(['db/wanted']);
});

test('cancelling the picker references nothing', async ({ page, workspaceId }) => {
  await routeDatasette(page);
  await startReference(page, 'https://ds.test/db');

  const picker = page.locator('table-select-dialog dialog');
  await expect(picker).toBeVisible();
  await picker.getByRole('button', { name: 'Cancel' }).click();

  await expect(picker).toBeHidden();
  expect(await tableNames(page, workspaceId)).toEqual([]);
});

test('a reference pages past the first response instead of stopping at it', async ({ page, workspaceId }) => {
  await routeDatasette(page);
  // A single-table URL needs no picker.
  await startReference(page, 'https://ds.test/db/wanted');

  await expect.poll(() => tableNames(page, workspaceId)).toEqual(['db/wanted']);

  // Both pages landed. Reading one page — the old behaviour, and the reason a
  // reference capped out at 1000 rows — would give just row 1.
  await expect
    .poll(() =>
      page.evaluate(async (w) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const store = (window as any).__easydb.store;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const t = (await store.tables.find()).find((x: any) => x.workspaceId === w);
        if (!t) return null;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return (await store.rows(t.id).find()).map((r: any) => r.data.id);
      }, workspaceId),
    )
    .toEqual([1, 2]);
});
