import { test, expect } from './fixtures.js';

/**
 * Importing a `.sql` script. The script this suite uploads is the shape
 * sql-export writes: `CREATE TABLE` + `INSERT` per table, then a labelled
 * `SELECT` for each projection — so this doubles as an end-to-end round trip
 * of the exporter, through real storage and the real projection provider.
 */

const SCRIPT = `-- easyDBAccess SQL dump
BEGIN;

DROP TABLE IF EXISTS "people";
CREATE TABLE "people" (
  "__id" TEXT PRIMARY KEY,
  "id" TEXT,
  "name" TEXT NOT NULL,
  "deptId" TEXT,
  "salary" NUMERIC
);
INSERT INTO "people" ("__id", "id", "name", "deptId", "salary") VALUES ('r1', 'p1', 'Alice', 'd1', 100);
INSERT INTO "people" ("__id", "id", "name", "deptId", "salary") VALUES ('r2', 'p2', 'Bob', 'd2', 90);
INSERT INTO "people" ("__id", "id", "name", "deptId", "salary") VALUES ('r3', 'p3', 'O''Brien', 'd9', 80);

DROP TABLE IF EXISTS "dept";
CREATE TABLE "dept" (
  "__id" TEXT PRIMARY KEY,
  "id" TEXT,
  "label" TEXT
);
INSERT INTO "dept" ("__id", "id", "label") VALUES ('r1', 'd1', 'Sales');
INSERT INTO "dept" ("__id", "id", "label") VALUES ('r2', 'd2', 'Support');

COMMIT;

-- projection: Staff by Dept
SELECT
  "p"."name" AS "who",
  "d"."label" AS "dept"
FROM "people" AS "p"
LEFT JOIN "dept" AS "d" ON "d"."id" = "p"."deptId";
`;

/** Every table in the workspace, with its row count and whether it is a projection. */
async function tables(page: import('@playwright/test').Page, ws: string) {
  return page.evaluate(async (ws) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const store = (window as any).__easydb.store;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const all = (await store.tables.find()).filter((t: any) => t.workspaceId === ws);
    return Promise.all(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      all.map(async (t: any) => ({
        name: t.name,
        projection: t.source?.type === 'projection',
        columns: t.columns.map((c: { field: string }) => c.field),
        // Sorted: the store makes no ordering promise, and neither does a
        // projection over it. These assertions are about CONTENT.
        rows: (await store.rows(t.id).find())
          .map((r: { data: Record<string, unknown> }) => r.data)
          .sort((a: Record<string, unknown>, b: Record<string, unknown>) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
      })),
    );
  }, ws);
}

async function uploadScript(page: import('@playwright/test').Page, name = 'dump.sql') {
  await page.getByTitle('Import data from a URL').click();
  const dlg = page.locator('import-dialog dialog');
  await expect(dlg).toBeVisible();
  await dlg.locator('input[type="file"]').setInputFiles({ name, mimeType: 'application/sql', buffer: Buffer.from(SCRIPT) });
  await dlg.getByRole('button', { name: 'Import', exact: true }).click();
}

test('a .sql script creates its tables, with typed columns and rows', async ({ page, workspaceId }) => {
  await uploadScript(page);

  await expect.poll(async () => (await tables(page, workspaceId)).length).toBe(3);
  const all = await tables(page, workspaceId);

  const people = all.find((t) => t.name === 'people')!;
  // The synthetic `__id` key is a row id, not a user column.
  expect(people.columns).toEqual(['id', 'name', 'deptId', 'salary']);
  expect(people.rows).toEqual([
    { id: 'p1', name: 'Alice', deptId: 'd1', salary: 100 },
    { id: 'p2', name: 'Bob', deptId: 'd2', salary: 90 },
    { id: 'p3', name: "O'Brien", deptId: 'd9', salary: 80 },
  ]);
  expect(all.find((t) => t.name === 'dept')!.rows).toHaveLength(2);
});

test('the SELECT becomes a live projection over the tables the same script created', async ({ page, workspaceId }) => {
  await uploadScript(page);
  await expect.poll(async () => (await tables(page, workspaceId)).length).toBe(3);

  const proj = (await tables(page, workspaceId)).find((t) => t.projection)!;
  expect(proj.name).toBe('Staff by Dept');
  expect(proj.columns).toEqual(['who', 'dept']);
  // Rows are COMPUTED by the projection provider, not stored — the LEFT JOIN
  // keeps O'Brien, whose dept d9 does not exist.
  expect(proj.rows).toEqual([
    { who: 'Alice', dept: 'Sales' },
    { who: 'Bob', dept: 'Support' },
    { who: "O'Brien", dept: null },
  ]);
});

test('the projection stays live: editing a source table updates it', async ({ page, workspaceId }) => {
  await uploadScript(page);
  await expect.poll(async () => (await tables(page, workspaceId)).length).toBe(3);

  await page.evaluate(async (ws) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const store = (window as any).__easydb.store;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const dept = (await store.tables.find()).find((t: any) => t.workspaceId === ws && t.name === 'dept');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const row = (await store.rows(dept.id).find()).find((r: any) => r.data.id === 'd1');
    await store.rows(dept.id).patch(row.id, { data: { ...row.data, label: 'Revenue' }, updatedAt: Date.now() });
  }, workspaceId);

  await expect.poll(async () => (await tables(page, workspaceId)).find((t) => t.projection)?.rows[0]).toEqual({ who: 'Alice', dept: 'Revenue' });
});

test('a script with no SELECT imports as plain tables through the kernel', async ({ page, workspaceId }) => {
  await page.getByTitle('Import data from a URL').click();
  const dlg = page.locator('import-dialog dialog');
  await dlg.locator('input[type="file"]').setInputFiles({
    name: 'tables-only.sql',
    mimeType: 'application/sql',
    buffer: Buffer.from(SCRIPT.slice(0, SCRIPT.indexOf('-- projection:'))),
  });
  await dlg.getByRole('button', { name: 'Import', exact: true }).click();

  // No projections, so this runs on the import kernel — which offers its
  // standard multi-table picker, the same one CSV and Datasette get.
  const picker = page.locator('table-select-dialog dialog');
  await expect(picker).toBeVisible();
  await picker.getByRole('button', { name: /^Import \(2\)$/ }).click();

  await expect.poll(async () => (await tables(page, workspaceId)).length).toBe(2);
  expect((await tables(page, workspaceId)).every((t) => !t.projection)).toBe(true);
});
