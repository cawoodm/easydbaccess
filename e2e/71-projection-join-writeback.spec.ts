import { test, expect } from './fixtures.js';
import { bulkAddRows, createTable, waitForPanel } from './helpers.js';

/**
 * Editing a JOINED column of a projection.
 *
 * The reported bug had two halves, both from the same cause — an output row
 * identified only its BASE row, so a joined value had nowhere provable to go:
 *
 *  1. joined columns were forced read-only, however unique the join;
 *  2. an edit that reached the collection anyway was silently discarded. A grid
 *     patch carries the WHOLE row, so the base table's unchanged fields looked
 *     writable, the write "succeeded", and the joined edit vanished — which is
 *     what happens when the edit comes from a VIEW of the projection.
 */

/** People ⋈ Dept on the two primary keys, 1:1. */
async function setup(page: import('@playwright/test').Page) {
  const deptId = await createTable(page, 'Dept', [
    { field: 'id' },
    { field: 'label' },
  ]);
  await bulkAddRows(page, deptId, [
    { id: 'd1', label: 'Sales' },
    { id: 'd2', label: 'Support' },
  ]);
  const peopleId = await createTable(page, 'People', [
    { field: 'name' },
    { field: 'deptId' },
  ]);
  await bulkAddRows(page, peopleId, [
    { name: 'Alice', deptId: 'd1' },
    { name: 'Bob', deptId: 'd2' },
  ]);

  // Created last so its panel is on top and its own footer is clickable.
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
      columns: [
        { field: 'who', label: 'Who', type: 'string' },
        // Stored the way the OLD rule left it, so this also proves the
        // load-time heal clears a stale flag.
        { field: 'dept', label: 'Dept', type: 'string', readonly: true },
      ],
      readonly: false,
      source: {
        type: 'projection',
        config: {
          version: 1,
          sources: [
            { alias: 'p', tableName: 'People' },
            {
              alias: 'd',
              tableName: 'Dept',
              join: {
                type: 'left',
                on: [{ field: 'id', eqAlias: 'p', eqField: 'deptId' }],
              },
            },
          ],
          columns: [
            {
              field: 'who',
              from: { kind: 'source', alias: 'p', field: 'name' },
            },
            {
              field: 'dept',
              from: { kind: 'source', alias: 'd', field: 'label' },
            },
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

/** Rows of a table, by field, sorted so order never matters. */
async function rowsOf(page: import('@playwright/test').Page, tableId: string) {
  return page.evaluate(async (id) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows = await (window as any).__easydb.store.rows(id).find();
    return rows
      .map((r: { data: Record<string, unknown> }) => r.data)
      .sort((a: unknown, b: unknown) =>
        JSON.stringify(a).localeCompare(JSON.stringify(b)),
      );
  }, tableId);
}

/**
 * Write a cell through the store exactly as the grid and a view both do.
 *
 * The row is picked by the value of `matchField`, never by index — `rowsOf`
 * sorts and the store does not, so an index would silently edit a different row.
 */
async function editCell(
  page: import('@playwright/test').Page,
  tableId: string,
  match: { field: string; value: unknown },
  field: string,
  value: string,
) {
  return page.evaluate(
    async ({ tableId, match, field, value }) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const store = (window as any).__easydb.store;
      const rows = await store.rows(tableId).find();
      const r = rows.find(
        (x: { data: Record<string, unknown> }) =>
          x.data[match.field] === match.value,
      );
      if (!r)
        return {
          ok: false,
          error: `no row where ${match.field} = ${String(match.value)}`,
        };
      try {
        // The whole row, which is what data-table sends — that is what made the
        // joined edit look writable and then disappear.
        await store
          .rows(tableId)
          .patch(r.id, {
            data: { ...r.data, [field]: value },
            updatedAt: Date.now(),
          });
        return { ok: true, error: '' };
      } catch (err) {
        return { ok: false, error: (err as Error).message };
      }
    },
    { tableId, match, field, value },
  );
}

test('a joined column is editable once the projection loads', async ({
  page,
}) => {
  const { projId } = await setup(page);

  // The stale readonly flag from the old rule is cleared at load.
  await expect
    .poll(async () =>
      page.evaluate(async (id) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const t = await (window as any).__easydb.store.tables.findOne(id);
        return t.columns.map(
          (c: { readonly?: boolean }) => c.readonly === true,
        );
      }, projId),
    )
    .toEqual([false, false]);
});

test('editing a joined field writes it to THAT table', async ({ page }) => {
  const { projId: id, deptId, peopleId } = await setup(page);

  await expect.poll(async () => (await rowsOf(page, id)).length).toBe(2);
  const res = await editCell(
    page,
    id,
    { field: 'who', value: 'Alice' },
    'dept',
    'Revenue',
  );
  expect(res).toEqual({ ok: true, error: '' });

  // Dept — the joined table — is the one that changed…
  await expect
    .poll(async () => rowsOf(page, deptId))
    .toEqual([
      { id: 'd1', label: 'Revenue' },
      { id: 'd2', label: 'Support' },
    ]);
  // …People is untouched…
  expect(await rowsOf(page, peopleId)).toEqual([
    { name: 'Alice', deptId: 'd1' },
    { name: 'Bob', deptId: 'd2' },
  ]);
  // …and the projection shows it, because it recomputes from the source.
  await expect
    .poll(async () => rowsOf(page, id))
    .toEqual([
      { who: 'Alice', dept: 'Revenue' },
      { who: 'Bob', dept: 'Support' },
    ]);
});

test('editing a base field still writes to the base table', async ({
  page,
}) => {
  const { projId, peopleId, deptId } = await setup(page);
  await expect.poll(async () => (await rowsOf(page, projId)).length).toBe(2);

  expect(
    await editCell(
      page,
      projId,
      { field: 'who', value: 'Alice' },
      'who',
      'Alicia',
    ),
  ).toEqual({
    ok: true,
    error: '',
  });
  await expect
    .poll(async () => rowsOf(page, peopleId))
    .toEqual([
      { name: 'Alicia', deptId: 'd1' },
      { name: 'Bob', deptId: 'd2' },
    ]);
  expect(await rowsOf(page, deptId)).toEqual([
    { id: 'd1', label: 'Sales' },
    { id: 'd2', label: 'Support' },
  ]);
});

test('a joined edit made through a VIEW of the projection reaches the joined table', async ({
  page,
}) => {
  // The exact path in the report: the edit goes through the view's grid, which
  // writes to the projection's row collection just like the table window does.
  const { projId, deptId } = await setup(page);
  await expect.poll(async () => (await rowsOf(page, projId)).length).toBe(2);

  const viewId = await page.evaluate(async (tableId) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ctx = (window as any).__easydb;
    const id = crypto.randomUUID();
    await ctx.store.viewInstances.insert({
      id,
      workspaceId: ctx.workspaceId,
      tableId,
      tableName: 'Staff',
      templateId: 'none',
      name: 'Staff cards',
      visibleColumns: ['who', 'dept'],
      mapping: {},
      open: true,
      updatedAt: Date.now(),
    });
    return id;
  }, projId);
  expect(viewId).toBeTruthy();

  // A view edits the SAME collection the grid does, so writing through the
  // projection's rows is exactly what the view's grid does on a cell change.
  expect(
    await editCell(
      page,
      projId,
      { field: 'who', value: 'Bob' },
      'dept',
      'Helpdesk',
    ),
  ).toEqual({
    ok: true,
    error: '',
  });

  await expect
    .poll(async () => rowsOf(page, deptId))
    .toEqual([
      { id: 'd1', label: 'Sales' },
      { id: 'd2', label: 'Helpdesk' },
    ]);
});

test('a joined edit with no matching row is refused, loudly, and changes nothing', async ({
  page,
}) => {
  const { projId, peopleId, deptId } = await setup(page);
  // Point Bob at a department that does not exist, so his `dept` is empty.
  await page.evaluate(async (id) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const store = (window as any).__easydb.store;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const bob = (await store.rows(id).find()).find(
      (r: any) => r.data.name === 'Bob',
    );
    await store
      .rows(id)
      .patch(bob.id, {
        data: { ...bob.data, deptId: 'gone' },
        updatedAt: Date.now(),
      });
  }, peopleId);

  await expect
    .poll(async () =>
      (await rowsOf(page, projId)).find(
        (r) => (r as { who: string }).who === 'Bob',
      ),
    )
    .toEqual({ who: 'Bob', dept: null });

  const res = await editCell(
    page,
    projId,
    { field: 'who', value: 'Bob' },
    'dept',
    'Nowhere',
  );

  expect(res.ok).toBe(false);
  expect(res.error).toMatch(/no matching "Dept" row/);
  // Nothing was invented anywhere.
  expect(await rowsOf(page, deptId)).toEqual([
    { id: 'd1', label: 'Sales' },
    { id: 'd2', label: 'Support' },
  ]);
});
