import { test, expect } from './fixtures.js';

/**
 * A snowflake id like 1298624375692894210 is past 2^53, so a JS number cannot
 * hold it: `Number('1298624375692894210')` is 1298624375692894200. Imported as a
 * number the id is silently WRONG — no error, and the shape still looks right.
 *
 * Every importer therefore keeps such a value as text. This drives the real
 * import path (URL → importer → store → grid) for CSV and JSON, and checks the
 * digits that come out the far end.
 */

const BIG = '1298624375692894210';
const BIG2 = '9007199254740993'; // one past MAX_SAFE_INTEGER

/** Field → value of the single imported row, read back out of the store. */
async function importedRow(page: import('@playwright/test').Page, ws: string, name: string): Promise<Record<string, unknown>> {
  return page.evaluate(
    async ([w, n]) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const store = (window as any).__easydb.store;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const tables = (await store.tables.find({ workspaceId: w })) as any[];
      const t = tables.find((x) => x.name === n);
      if (!t) return {};
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const rows = (await store.rows(t.id).find()) as any[];
      return rows[0]?.data ?? {};
    },
    [ws, name],
  );
}

/** The imported row whose `field` equals `value`, read back out of the store. */
async function importedRowWhere(page: import('@playwright/test').Page, ws: string, name: string, field: string, value: string): Promise<Record<string, unknown>> {
  return page.evaluate(
    async ([w, n, f, v]) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const store = (window as any).__easydb.store;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const tables = (await store.tables.find({ workspaceId: w })) as any[];
      const t = tables.find((x) => x.name === n);
      if (!t) return {};
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const rows = (await store.rows(t.id).find()) as any[];
      return rows.find((r) => String(r.data?.[f as string]) === v)?.data ?? {};
    },
    [ws, name, field, value],
  );
}

async function importUrl(page: import('@playwright/test').Page, url: string, body: string, contentType: string, format: string) {
  await page.route(url, (route) =>
    route.fulfill({
      status: 200,
      contentType,
      headers: { 'access-control-allow-origin': '*' },
      body,
    }),
  );
  await page.getByTitle('Import data from a URL').click();
  const dlg = page.locator('import-dialog dialog');
  await expect(dlg).toBeVisible();
  await dlg.locator('input[type="text"]').fill(url);
  await dlg.getByTestId('import-format').selectOption(format);
  await dlg.getByRole('button', { name: 'Import', exact: true }).click();
}

test('a CSV id past 2^53 keeps every digit, as text', async ({ page, workspaceId }) => {
  await importUrl(page, 'https://ex.example/ids.csv', `id,name\n${BIG},Ada\n`, 'text/plain; charset=utf-8', 'csv');

  await expect.poll(() => importedRow(page, workspaceId, 'ids')).toEqual({ id: BIG, name: 'Ada' });
  // And it is on screen in full, not rounded. A string cell renders as an
  // editable input, so the digits are its VALUE, not its text.
  await expect.poll(() => page.locator('data-table tbody').first().locator('input').first().inputValue()).toBe(BIG);
});

test('a JSON id past 2^53 keeps every digit — JSON.parse cannot be trusted with it', async ({ page, workspaceId }) => {
  // The literal is unquoted in the source, which is where the damage used to
  // happen: the parse itself rounds it, and no reviver can recover the digits.
  await importUrl(page, 'https://ex.example/ids.json', `[{"id":${BIG},"other":${BIG2},"small":42}]`, 'application/json', 'json');

  await expect.poll(() => importedRow(page, workspaceId, 'ids')).toEqual({ id: BIG, other: BIG2, small: 42 });
});

test('ordinary numbers still import as numbers', async ({ page, workspaceId }) => {
  // The guard must not turn every id column into text.
  await importUrl(page, 'https://ex.example/small.csv', 'n,m\n42,9007199254740991\n', 'text/plain; charset=utf-8', 'csv');

  await expect.poll(() => importedRow(page, workspaceId, 'small')).toEqual({ n: 42, m: 9007199254740991 });
});

test('a JSON decimal with a long fraction imports, and keeps its value', async ({ page, workspaceId }) => {
  // The rewrite that protects big integers used to break long decimals: it emitted
  // the integer part, copied the `.` as an ordinary character, then re-scanned the
  // fraction digits as a number literal of their own — 9040000000000001 is past
  // 2^53, so it was quoted, and the document no longer parsed. A file this app had
  // exported failed to import with "Unterminated fractional number".
  const body = JSON.stringify([
    { plant: 'ALUMINE', capacity_mw: 1.9040000000000001, latitude: -39.2145, id: BIG },
    { plant: 'Bern', capacity_mw: 0.30000000000000004, latitude: 46.948, id: BIG2 },
  ]);
  await importUrl(page, 'https://ex.example/plants.json', body, 'application/json', 'json');

  // BY NAME, not `rows[0]`: the store does not promise insertion order (the
  // primary key is a random UUID), so a two-row fixture cannot be indexed into.
  await expect.poll(() => importedRowWhere(page, workspaceId, 'plants', 'plant', 'ALUMINE')).toEqual({
    plant: 'ALUMINE',
    capacity_mw: 1.9040000000000001,
    latitude: -39.2145,
    // The integers beside it are still protected — the fix must not cost that.
    id: BIG,
  });
  await expect.poll(() => importedRowWhere(page, workspaceId, 'plants', 'plant', 'Bern')).toEqual({
    plant: 'Bern',
    capacity_mw: 0.30000000000000004,
    latitude: 46.948,
    id: BIG2,
  });
});
