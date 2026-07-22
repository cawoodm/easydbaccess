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

/**
 * Stub an instance whose metadata endpoint returns NO column list (older
 * Datasette, or an `_extra` the server ignores) — the shape that caused
 * "rows imported but the table has no columns". Rows still come back.
 */
async function stubDatasetteNoColumnMeta(page: import('@playwright/test').Page): Promise<void> {
  await page.evaluate(() => {
    const orig = window.fetch.bind(window);
    window.fetch = (async (input: unknown, init?: unknown) => {
      const url = String(
        typeof input === 'string' ? input : (input as { url?: string })?.url ?? input,
      );
      if (url.includes('ds.example.test')) {
        const isMeta = new URL(url).searchParams.get('_size') === '0';
        const body = isMeta
          ? { ok: true, count: 3, primary_keys: ['id'] } // no columns / column_details
          : {
              ok: true,
              next_url: null,
              rows: [
                { id: 1, name: 'Alpha', capacity_mw: 12.5, commissioned_at: '2001-05-01' },
                { id: 2, name: 'Beta', capacity_mw: 7, commissioned_at: '2010-01-01' },
                { id: 3, name: 'Gamma', capacity_mw: 3.2, commissioned_at: '2020-11-20' },
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

/**
 * Stub a whole database: a `<db>.json` page listing tables (one hidden), plus
 * meta + rows for each real table. Exercises database-level import.
 */
async function stubDatasetteDatabase(page: import('@playwright/test').Page): Promise<void> {
  await page.evaluate(() => {
    const orig = window.fetch.bind(window);
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    window.fetch = (async (input: unknown, init?: unknown) => {
      const url = String(
        typeof input === 'string' ? input : (input as { url?: string })?.url ?? input,
      );
      if (url.includes('ds.example.test')) {
        const u = new URL(url);
        const segs = u.pathname.replace(/\.json$/, '').split('/').filter(Boolean);
        if (segs.length === 1) {
          // Database page: two real tables (with row counts) + one hidden table.
          return json({
            ok: true,
            tables: [
              { name: 'plants', count: 2 },
              { name: 'regions', count: 1 },
              { name: 'plants_fts', hidden: true },
            ],
          });
        }
        const table = segs[1];
        const isMeta = u.searchParams.get('_size') === '0';
        if (table === 'plants') {
          return json(
            isMeta
              ? { ok: true, count: 2, primary_keys: ['id'], columns: ['id', 'name'] }
              : { ok: true, next_url: null, rows: [{ id: 1, name: 'Alpha' }, { id: 2, name: 'Beta' }] },
          );
        }
        if (table === 'regions') {
          return json(
            isMeta
              ? { ok: true, count: 1, primary_keys: ['id'], columns: ['id', 'region'] }
              : { ok: true, next_url: null, rows: [{ id: 1, region: 'North' }] },
          );
        }
        return json({ ok: true, rows: [] }); // hidden tables should never be fetched
      }
      return orig(input as RequestInfo, init as RequestInit);
    }) as typeof window.fetch;
  });
}

/**
 * Stub where the URL path looks like a table (`catalog/overview`) but the
 * response at that path is a database page. Detection must follow the response.
 */
async function stubDatasetteResponseOverride(page: import('@playwright/test').Page): Promise<void> {
  await page.evaluate(() => {
    const orig = window.fetch.bind(window);
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    window.fetch = (async (input: unknown, init?: unknown) => {
      const url = String(
        typeof input === 'string' ? input : (input as { url?: string })?.url ?? input,
      );
      if (url.includes('ov.example.test')) {
        const segs = new URL(url).pathname.replace(/\.json$/, '').split('/').filter(Boolean);
        if (segs[1] === 'overview') {
          // Probe target: responds like a database, not a table.
          return json({ ok: true, tables: [{ name: 'books' }, { name: 'authors' }] });
        }
        return json({ ok: true, next_url: null, rows: [{ id: 1, title: `${segs[1]}-row` }] });
      }
      return orig(input as RequestInfo, init as RequestInit);
    }) as typeof window.fetch;
  });
}

/**
 * Stub a table paginated with Datasette 1.0's `next` cursor token (no
 * `next_url`): page 1 returns two rows + next="2", page 2 (?_next=2) returns
 * the last row + next=null. Metadata has no columns (inference path).
 */
async function stubDatasettePaging(page: import('@playwright/test').Page): Promise<void> {
  await page.evaluate(() => {
    const orig = window.fetch.bind(window);
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    window.fetch = (async (input: unknown, init?: unknown) => {
      const url = String(
        typeof input === 'string' ? input : (input as { url?: string })?.url ?? input,
      );
      if (url.includes('pg.example.test')) {
        const params = new URL(url).searchParams;
        if (params.get('_size') === '0') return json({ ok: true, count: 3, primary_keys: ['id'] });
        if (params.get('_next') === '2') return json({ ok: true, next: null, rows: [{ id: 3, v: 'c' }] });
        return json({ ok: true, next: '2', rows: [{ id: 1, v: 'a' }, { id: 2, v: 'b' }] });
      }
      return orig(input as RequestInfo, init as RequestInit);
    }) as typeof window.fetch;
  });
}

/** Confirm the database table-picker (imports the currently-selected tables). */
async function confirmPicker(page: import('@playwright/test').Page): Promise<void> {
  await page.locator('datasette-table-picker button[type="submit"]').click();
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

  test('infers columns from rows when metadata has none', async ({ page }) => {
    await stubDatasetteNoColumnMeta(page);

    await page.locator('app-shell header button[title="Import data from a URL"]').click();
    await page.locator('import-dialog input[type="text"]').fill(TABLE_URL);
    await page.locator('import-dialog select').nth(1).selectOption('datasette');
    await page.locator('import-dialog button[type="submit"]').click();

    await expect
      .poll(async () =>
        page.evaluate(async () => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const ctx = (window as any).__easydb;
          const tables = await ctx.store.tables.find();
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const t = tables.find((x: any) => x.name === 'energy/plants');
          return t ? t.columns.length : 0;
        }),
      )
      .toBe(4);

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
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        fields: t.columns.map((c: any) => c.field),
        idType: col('id')?.type,
        idUnique: col('id')?.unique === true,
        nameType: col('name')?.type,
        capacityType: col('capacity_mw')?.type,
        commissionedType: col('commissioned_at')?.type,
      };
    });

    // The bug: rows import but columns stay empty. Now they're inferred.
    expect(info.rowCount).toBe(3);
    expect(info.fields).toEqual(['id', 'name', 'capacity_mw', 'commissioned_at']);
    expect(info.idType).toBe('number'); // value-inferred
    expect(info.idUnique).toBe(true); // primary_keys still honoured
    expect(info.nameType).toBe('string');
    expect(info.capacityType).toBe('number');
    expect(info.commissionedType).toBe('datetime'); // name heuristic
  });

  test('follows the Datasette 1.0 `next` cursor across pages', async ({ page }) => {
    await stubDatasettePaging(page);

    await page.locator('app-shell header button[title="Import data from a URL"]').click();
    await page.locator('import-dialog input[type="text"]').fill('https://pg.example.test/db/big');
    await page.locator('import-dialog select').nth(1).selectOption('datasette');
    await page.locator('import-dialog button[type="submit"]').click();

    // Both pages (2 + 1 rows) must be imported, not just the first.
    await expect
      .poll(async () =>
        page.evaluate(async () => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const ctx = (window as any).__easydb;
          const tables = await ctx.store.tables.find();
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const t = tables.find((x: any) => x.name === 'db/big');
          return t ? (await ctx.store.rows(t.id).find()).length : -1;
        }),
      )
      .toBe(3);
  });

  test('imports every non-hidden table from a Datasette database URL', async ({ page }) => {
    await stubDatasetteDatabase(page);

    await page.locator('app-shell header button[title="Import data from a URL"]').click();
    await page.locator('import-dialog input[type="text"]').fill('https://ds.example.test/energy');
    await page.locator('import-dialog select').nth(1).selectOption('datasette');
    await page.locator('import-dialog button[type="submit"]').click();

    // A picker lists the database's tables (all selected by default); confirm it.
    await confirmPicker(page);

    await expect
      .poll(async () =>
        page.evaluate(async () => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const ctx = (window as any).__easydb;
          const tables = await ctx.store.tables.find();
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          return tables.map((t: any) => t.name).sort();
        }),
      )
      .toEqual(['energy/plants', 'energy/regions']);

    const info = await page.evaluate(async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ctx = (window as any).__easydb;
      const tables = await ctx.store.tables.find();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const byName: Record<string, any> = Object.fromEntries(tables.map((t: any) => [t.name, t]));
      const rowCount = async (n: string) => (await ctx.store.rows(byName[n].id).find()).length;
      return {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        names: tables.map((t: any) => t.name),
        plants: await rowCount('energy/plants'),
        regions: await rowCount('energy/regions'),
      };
    });

    expect(info.plants).toBe(2);
    expect(info.regions).toBe(1);
    // The hidden FTS shadow table must be skipped.
    expect(info.names).not.toContain('energy/plants_fts');
  });

  test('the picker shows row counts and estimated sizes', async ({ page }) => {
    await stubDatasetteDatabase(page);

    await page.locator('app-shell header button[title="Import data from a URL"]').click();
    await page.locator('import-dialog input[type="text"]').fill('https://ds.example.test/energy');
    await page.locator('import-dialog select').nth(1).selectOption('datasette');
    await page.locator('import-dialog button[type="submit"]').click();

    const picker = page.locator('datasette-table-picker');
    await expect(picker).toContainText('2 rows'); // plants
    await expect(picker).toContainText('1 row'); // regions
    // Size estimate resolves to a byte/KB/MB figure (the "…" placeholder clears).
    await expect(picker.locator('.list')).toContainText(/\d+\s?(B|KB|MB)/);

    await confirmPicker(page);
    await expect
      .poll(async () =>
        page.evaluate(async () => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const ctx = (window as any).__easydb;
          return (await ctx.store.tables.find()).length;
        }),
      )
      .toBe(2);
  });

  test('re-importing a database overwrites existing tables by default', async ({ page }) => {
    await stubDatasetteDatabase(page);
    const names = async () =>
      page.evaluate(async () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const ctx = (window as any).__easydb;
        const tables = await ctx.store.tables.find();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return tables.map((t: any) => t.name).sort();
      });

    const importEnergy = async () => {
      await page.locator('app-shell header button[title="Import data from a URL"]').click();
      await page.locator('import-dialog input[type="text"]').fill('https://ds.example.test/energy');
      await page.locator('import-dialog select').nth(1).selectOption('datasette');
      await page.locator('import-dialog button[type="submit"]').click();
      await confirmPicker(page);
    };

    await importEnergy();
    await expect.poll(names).toEqual(['energy/plants', 'energy/regions']);

    // Second import: both tables now show as "exists"; default is Overwrite.
    await importEnergy();
    await expect(page.locator('datasette-table-picker')).toBeHidden(); // picker closed
    // Still exactly two tables — overwritten in place, not duplicated.
    await expect.poll(names).toEqual(['energy/plants', 'energy/regions']);
  });

  test('the picker can rename on collision to keep both copies', async ({ page }) => {
    await stubDatasetteDatabase(page);
    const names = async () =>
      page.evaluate(async () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const ctx = (window as any).__easydb;
        const tables = await ctx.store.tables.find();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return tables.map((t: any) => t.name).sort();
      });

    const openEnergy = async () => {
      await page.locator('app-shell header button[title="Import data from a URL"]').click();
      await page.locator('import-dialog input[type="text"]').fill('https://ds.example.test/energy');
      await page.locator('import-dialog select').nth(1).selectOption('datasette');
      await page.locator('import-dialog button[type="submit"]').click();
    };

    await openEnergy();
    await confirmPicker(page);
    await expect.poll(names).toEqual(['energy/plants', 'energy/regions']);

    // Re-import; keep the existing "plants" by importing the new one under a new name.
    await openEnergy();
    await page.locator('datasette-table-picker select[data-mode="plants"]').selectOption('rename');
    await confirmPicker(page);
    await expect.poll(names).toEqual(['energy/plants', 'energy/plants (2)', 'energy/regions']);
  });

  test('database import lets you deselect tables in the picker', async ({ page }) => {
    await stubDatasetteDatabase(page);

    await page.locator('app-shell header button[title="Import data from a URL"]').click();
    await page.locator('import-dialog input[type="text"]').fill('https://ds.example.test/energy');
    await page.locator('import-dialog select').nth(1).selectOption('datasette');
    await page.locator('import-dialog button[type="submit"]').click();

    // Deselect "regions" in the picker, then import.
    await page.locator('datasette-table-picker input[data-table="regions"]').uncheck();
    await confirmPicker(page);

    await expect
      .poll(async () =>
        page.evaluate(async () => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const ctx = (window as any).__easydb;
          const tables = await ctx.store.tables.find();
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          return tables.map((t: any) => t.name).sort();
        }),
      )
      .toEqual(['energy/plants']);

    // "regions" was deselected, so it must not have been imported.
    const names = await page.evaluate(async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ctx = (window as any).__easydb;
      const tables = await ctx.store.tables.find();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return tables.map((t: any) => t.name);
    });
    expect(names).not.toContain('energy/regions');
  });

  test('detects database vs table from the response, not the URL path', async ({ page }) => {
    await stubDatasetteResponseOverride(page);

    await page.locator('app-shell header button[title="Import data from a URL"]').click();
    // Path parses as a table (db "catalog", table "overview"), but the response
    // is a database page — so all its tables should be imported.
    await page.locator('import-dialog input[type="text"]').fill('https://ov.example.test/catalog/overview');
    await page.locator('import-dialog select').nth(1).selectOption('datasette');
    await page.locator('import-dialog button[type="submit"]').click();
    await confirmPicker(page);

    await expect
      .poll(async () =>
        page.evaluate(async () => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const ctx = (window as any).__easydb;
          const tables = await ctx.store.tables.find();
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          return tables.map((t: any) => t.name).sort();
        }),
      )
      .toEqual(['catalog/authors', 'catalog/books']);

    const names = await page.evaluate(async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ctx = (window as any).__easydb;
      const tables = await ctx.store.tables.find();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return tables.map((t: any) => t.name);
    });
    // Path-based dispatch would have created a single "catalog/overview" table.
    expect(names).not.toContain('catalog/overview');
  });

  test('sample sources point at real URLs (table + whole database)', async ({ page }) => {
    // Guards against the regression this suite was written for: the old power
    // plants sample pointed at the retired global-power-plants.datasettes.com.
    await page.locator('app-shell header button[title="Import data from a URL"]').click();
    const dialog = page.locator('import-dialog');
    const url = dialog.locator('input[type="text"]');
    const kind = dialog.locator('select').nth(1);
    const preset = dialog.locator('select').first();

    await preset.selectOption({ label: 'Datasette — global power plants (table)' });
    await expect(url).toHaveValue('https://datasette.io/global-power-plants/global-power-plants');
    await expect(kind).toHaveValue('datasette');

    await preset.selectOption({ label: 'Datasette — US legislators (whole database)' });
    await expect(url).toHaveValue('https://datasette.io/legislators');
    await expect(kind).toHaveValue('datasette');
  });
});
