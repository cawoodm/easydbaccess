import { test, expect } from './fixtures.js';
import { bulkAddRows, createTable, panelDomId, waitForPanel } from './helpers.js';

/**
 * The per-table Copy button. Three answers to "what should the copy contain?":
 * Duplicate (the same KIND of thing), Raw Data and Visible Data (a plain local
 * table holding the rows as they are now).
 *
 * The interesting case is a projection: duplicating one gives a second live
 * projection, while Raw/Visible FREEZE it into an ordinary editable table.
 */

/** Every table in the workspace, with what it is and what it holds. */
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
        readonly: t.readonly === true,
        columns: t.columns.map((c: { field: string }) => c.field),
        rows: (await store.rows(t.id).find())
          .map((r: { data: Record<string, unknown> }) => r.data)
          .sort((a: unknown, b: unknown) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
      })),
    );
  }, ws);
}

async function pressCopy(page: import('@playwright/test').Page, tableId: string, option: string) {
  await page
    .locator(`#${panelDomId(tableId)} panel-footer`)
    .getByRole('button', { name: /^Copy$/ })
    .click();
  const host = page.locator('host-dialogs');
  await expect(host.getByText(/what should the copy contain/)).toBeVisible();
  await host.getByRole('button', { name: option, exact: true }).click();
}

async function setupPlain(page: import('@playwright/test').Page) {
  const id = await createTable(page, 'People', [{ field: 'name' }, { field: 'secret' }]);
  await waitForPanel(page, id);
  await bulkAddRows(page, id, [
    { name: 'Alice', secret: 'x' },
    { name: 'Bob', secret: 'y' },
  ]);
  return id;
}

test('Duplicate copies a plain table with all its rows', async ({ page, workspaceId }) => {
  const id = await setupPlain(page);
  await pressCopy(page, id, 'Duplicate');

  await expect.poll(async () => (await tables(page, workspaceId)).length).toBe(2);
  const copy = (await tables(page, workspaceId)).find((t) => t.name === 'People copy')!;
  expect(copy.columns).toEqual(['name', 'secret']);
  expect(copy.rows).toEqual([
    { name: 'Alice', secret: 'x' },
    { name: 'Bob', secret: 'y' },
  ]);
});

test('Visible Data drops hidden columns and applies the filter', async ({ page, workspaceId }) => {
  const id = await setupPlain(page);
  // Hide a column and filter the rows, exactly as the grid would.
  await page.evaluate(async (tableId) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const store = (window as any).__easydb.store;
    const t = await store.tables.findOne(tableId);
    await store.tables.patch(tableId, {
      columns: t.columns.map((c: { field: string }) =>
        c.field === 'secret' ? { ...c, hidden: true } : c,
      ),
      filters: { name: 'ali' },
      updatedAt: Date.now(),
    });
  }, id);

  await pressCopy(page, id, 'Visible Data');

  await expect.poll(async () => (await tables(page, workspaceId)).length).toBe(2);
  const copy = (await tables(page, workspaceId)).find((t) => t.name === 'People copy')!;
  expect(copy.columns).toEqual(['name']);
  expect(copy.rows.map((r) => (r as { name: string }).name)).toEqual(['Alice']);
});

test.describe('copying a projection', () => {
  /** People + Dept, with a live projection over them. */
  async function setupProjection(page: import('@playwright/test').Page) {
    // Panels stack in creation order, so the projection — whose footer these
    // tests press — is created LAST and ends up on top. (It resolves its
    // sources by name whenever it computes, so the order costs it nothing.)
    const deptId = await createTable(page, 'Dept', [{ field: 'id' }, { field: 'label' }]);
    await bulkAddRows(page, deptId, [{ id: 'd1', label: 'Sales' }]);
    const peopleId = await createTable(page, 'People', [{ field: 'name' }, { field: 'deptId' }]);
    await bulkAddRows(page, peopleId, [{ name: 'Alice', deptId: 'd1' }]);

    const projId = await page.evaluate(async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ctx = (window as any).__easydb;
      const id = crypto.randomUUID();
      await ctx.store.tables.insert({
        id,
        workspaceId: ctx.workspaceId,
        name: 'Staff',
        code: 'staff',
        view: 'table',
        readonly: false,
        columns: [
          { field: 'who', label: 'Who', type: 'string' },
          { field: 'dept', label: 'Dept', type: 'string', readonly: true },
        ],
        source: {
          type: 'projection',
          config: {
            version: 1,
            sources: [
              { alias: 'p', tableName: 'People' },
              {
                alias: 'd',
                tableName: 'Dept',
                join: { type: 'left', on: [{ field: 'id', eqAlias: 'p', eqField: 'deptId' }] },
              },
            ],
            columns: [
              { field: 'who', from: { kind: 'source', alias: 'p', field: 'name' } },
              { field: 'dept', from: { kind: 'source', alias: 'd', field: 'label' } },
            ],
          },
        },
        updatedAt: Date.now(),
      });
      return id;
    });
    await waitForPanel(page, projId);
    return { projId, peopleId, deptId };
  }

  test('Duplicate gives a SECOND live projection, still tracking its sources', async ({
    page,
    workspaceId,
  }) => {
    const { projId, deptId } = await setupProjection(page);
    await pressCopy(page, projId, 'Duplicate');

    await expect.poll(async () => (await tables(page, workspaceId)).length).toBe(4);
    const copy = (await tables(page, workspaceId)).find((t) => t.name === 'Staff copy')!;
    expect(copy.projection).toBe(true);
    expect(copy.rows).toEqual([{ who: 'Alice', dept: 'Sales' }]);

    // Still live: change a source and the COPY follows.
    await page.evaluate(async (dept) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const store = (window as any).__easydb.store;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const r = (await store.rows(dept).find())[0] as any;
      await store
        .rows(dept)
        .patch(r.id, { data: { ...r.data, label: 'Revenue' }, updatedAt: Date.now() });
    }, deptId);

    await expect
      .poll(
        async () => (await tables(page, workspaceId)).find((t) => t.name === 'Staff copy')?.rows,
      )
      .toEqual([{ who: 'Alice', dept: 'Revenue' }]);
  });

  test('Raw Data FREEZES it into a plain table that no longer follows its sources', async ({
    page,
    workspaceId,
  }) => {
    const { projId, deptId } = await setupProjection(page);
    await pressCopy(page, projId, 'Raw Data');

    await expect.poll(async () => (await tables(page, workspaceId)).length).toBe(4);
    const copy = (await tables(page, workspaceId)).find((t) => t.name === 'Staff copy')!;
    expect(copy.projection).toBe(false);
    expect(copy.rows).toEqual([{ who: 'Alice', dept: 'Sales' }]);

    // A snapshot: the same source edit must NOT reach it.
    await page.evaluate(async (dept) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const store = (window as any).__easydb.store;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const r = (await store.rows(dept).find())[0] as any;
      await store
        .rows(dept)
        .patch(r.id, { data: { ...r.data, label: 'Revenue' }, updatedAt: Date.now() });
    }, deptId);

    // The ORIGINAL projection moves…
    await expect
      .poll(async () => (await tables(page, workspaceId)).find((t) => t.name === 'Staff')?.rows)
      .toEqual([{ who: 'Alice', dept: 'Revenue' }]);
    // …and the snapshot stays where it was.
    expect((await tables(page, workspaceId)).find((t) => t.name === 'Staff copy')!.rows).toEqual([
      { who: 'Alice', dept: 'Sales' },
    ]);
  });

  test('a frozen copy is editable — the projection’s read-only columns are not', async ({
    page,
    workspaceId,
  }) => {
    const { projId } = await setupProjection(page);
    await pressCopy(page, projId, 'Raw Data');
    await expect.poll(async () => (await tables(page, workspaceId)).length).toBe(4);

    const readonlyFlags = await page.evaluate(async (ws) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const store = (window as any).__easydb.store;
      const t = (await store.tables.find()).find(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (x: any) => x.workspaceId === ws && x.name === 'Staff copy',
      );
      return {
        table: t.readonly === true,
        columns: t.columns.map((c: { readonly?: boolean }) => c.readonly === true),
      };
    }, workspaceId);

    expect(readonlyFlags.table).toBe(false);
    expect(readonlyFlags.columns).toEqual([false, false]);
  });
});
