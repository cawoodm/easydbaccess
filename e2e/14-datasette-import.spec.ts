import { test, expect } from './fixtures.js';

/**
 * Datasette import (PR #1 / Phase 1), reachable from the Import dialog added
 * by the `import-data` built-in.
 *
 * The import talks to a Datasette instance through `api.backend.fetch`, which
 * — with no sync server configured — is a plain browser `fetch`. We stub
 * `window.fetch` to serve Datasette-shaped JSON for a fake instance, so the
 * test is hermetic: it exercises URL parsing, schema → ColumnType mapping and
 * row materialization without depending on a live host (or its CORS config).
 */

const INSTANCE = 'https://ds.example.test';
const TABLE_URL = `${INSTANCE}/energy/plants`;

/** Serve Datasette metadata + rows for our fake instance; pass everything else through. */
async function stubDatasette(page: import('@playwright/test').Page): Promise<void> {
  await page.evaluate(() => {
    const orig = window.fetch.bind(window);
    window.fetch = (async (input: unknown, init?: unknown) => {
      const url = String(
        typeof input === 'string' ? input : (input as { url?: string })?.url ?? input,
      );
      if (url.includes('ds.example.test')) {
        // The meta request is the one asking for zero rows (_size=0); the row
        // request follows with _size=max. Both hit <base>/<db>/<table>.json.
        const isMeta = new URL(url).searchParams.get('_size') === '0';
        const body = isMeta
          ? {
              ok: true,
              count: 3,
              primary_keys: ['id'],
              columns: ['id', 'name', 'capacity_mw', 'is_active', 'commissioned_at'],
              column_details: [
                { column: 'id', sqlite_type: 'INTEGER', is_pk: 1, notnull: 1 },
                { column: 'name', sqlite_type: 'TEXT' },
                { column: 'capacity_mw', sqlite_type: 'REAL' },
                { column: 'is_active', sqlite_type: 'INTEGER' },
                { column: 'commissioned_at', sqlite_type: 'TEXT' },
              ],
              rows: [],
            }
          : {
              ok: true,
              next_url: null,
              rows: [
                { id: 1, name: 'Alpha', capacity_mw: 12.5, is_active: 1, commissioned_at: '2001-05-01' },
                { id: 2, name: 'Beta', capacity_mw: 7, is_active: 0, commissioned_at: '2010-01-01' },
                { id: 3, name: 'Gamma', capacity_mw: 3.2, is_active: 1, commissioned_at: '2020-11-20' },
              ],
            };
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return orig(input as RequestInfo, init as RequestInit);
    }) as typeof window.fetch;
  });
}

test.describe('datasette import', () => {
  test('imports a Datasette table via the Import dialog', async ({ page }) => {
    await stubDatasette(page);

    await page.locator('app-shell header button[title="Import data from a URL"]').click();

    // Paste the table URL and force the Datasette route, then import.
    await page.locator('import-dialog input[type="text"]').fill(TABLE_URL);
    await page.locator('import-dialog select').nth(1).selectOption('datasette');
    await page.locator('import-dialog button[type="submit"]').click();

    // A local table named "<db>/<table>" should appear.
    await expect
      .poll(async () =>
        page.evaluate(async () => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const ctx = (window as any).__easydb;
          const tables = await ctx.store.tables.find();
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          return tables.map((t: any) => t.name);
        }),
      )
      .toContain('energy/plants');

    const info = await page.evaluate(async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ctx = (window as any).__easydb;
      const tables = await ctx.store.tables.find();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const t = tables.find((x: any) => x.name === 'energy/plants');
      const rows = await ctx.store.rows(t.id).find();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const col = (f: string) => t.columns.find((c: any) => c.field === f);
      return {
        rowCount: rows.length,
        idType: col('id')?.type,
        idUnique: col('id')?.unique === true,
        nameType: col('name')?.type,
        capacityType: col('capacity_mw')?.type,
        activeType: col('is_active')?.type,
        commissionedType: col('commissioned_at')?.type,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        names: rows.map((r: any) => r.data.name).sort(),
      };
    });

    expect(info.rowCount).toBe(3);
    expect(info.names).toEqual(['Alpha', 'Beta', 'Gamma']);
    // SQLite type + column-name heuristics → eda ColumnType.
    expect(info.idType).toBe('number');
    expect(info.idUnique).toBe(true); // primary key → unique
    expect(info.nameType).toBe('string');
    expect(info.capacityType).toBe('number'); // REAL
    expect(info.activeType).toBe('boolean'); // "is_" prefix
    expect(info.commissionedType).toBe('datetime'); // "_at" suffix
  });

  test('the global-power-plants sample points at a real table URL', async ({ page }) => {
    // Guards against the regression this test suite was written for: the old
    // sample pointed at the retired global-power-plants.datasettes.com host.
    await page.locator('app-shell header button[title="Import data from a URL"]').click();
    const dialog = page.locator('import-dialog');
    await dialog.locator('select').first().selectOption({ label: 'Datasette — global power plants' });

    await expect(dialog.locator('input[type="text"]')).toHaveValue(
      'https://datasette.io/global-power-plants/global-power-plants',
    );
    await expect(dialog.locator('select').nth(1)).toHaveValue('datasette');
  });
});
