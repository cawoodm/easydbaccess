import { test, expect } from './fixtures.js';
import { bulkAddRows, createTable, panelDomId, waitForPanel } from './helpers.js';

/**
 * A projection binds to its sources BY NAME, and so does a view instance. So
 * renaming a source table is the one edit that can break them — and the columns
 * editor has to say so before it writes, then carry the references across.
 */

/** A projection over People + Dept, inserted the way the editor compiles one. */
async function addProjection(page: import('@playwright/test').Page, name = 'Staff'): Promise<string> {
  return page.evaluate(async (name) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ctx = (window as any).__easydb;
    const id = crypto.randomUUID();
    await ctx.store.tables.insert({
      id,
      workspaceId: ctx.workspaceId,
      name,
      code: name.toLowerCase(),
      view: 'table',
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
  }, name);
}

/** The source table names the projection currently binds to. */
async function sourceNames(page: import('@playwright/test').Page, projId: string): Promise<string[]> {
  return page.evaluate(async (id) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const t = await (window as any).__easydb.store.tables.findOne(id);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (t.source.config.sources as any[]).map((s) => s.tableName);
  }, projId);
}

async function projectionRows(page: import('@playwright/test').Page, projId: string) {
  return page.evaluate(async (id) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows = await (window as any).__easydb.store.rows(id).find();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return rows.map((r: any) => r.data);
  }, projId);
}

/** Open the columns editor for a table and type a new table name. */
async function renameTo(page: import('@playwright/test').Page, tableId: string, next: string) {
  await page
    .locator(`#${panelDomId(tableId)}`)
    .locator('panel-footer')
    .getByRole('button', { name: /Columns/ })
    .click();
  const dlg = page.locator('new-table-dialog dialog');
  await expect(dlg).toBeVisible();
  await dlg.locator('input').first().fill(next);
  await dlg.getByRole('button', { name: 'Save', exact: true }).click();
}

async function setup(page: import('@playwright/test').Page) {
  // Order matters for the CLICKS, not the data: panels stack in creation order,
  // so People — the one whose footer these tests press — is created last and
  // ends up on top. (A projection resolves its sources by name whenever it
  // computes, so it can be created before the tables it reads.)
  const projId = await addProjection(page);
  const deptId = await createTable(page, 'Dept', [{ field: 'id' }, { field: 'label' }]);
  await bulkAddRows(page, deptId, [{ id: 'd1', label: 'Sales' }]);
  const peopleId = await createTable(page, 'People', [{ field: 'name' }, { field: 'deptId' }]);
  await bulkAddRows(page, peopleId, [{ name: 'Alice', deptId: 'd1' }]);
  await waitForPanel(page, peopleId);
  return { peopleId, deptId, projId };
}

test('renaming a referenced table warns, names the projection, and can be cancelled', async ({ page }) => {
  const { peopleId, projId } = await setup(page);

  await renameTo(page, peopleId, 'Crew');

  const host = page.locator('host-dialogs');
  await expect(host.getByText(/Renaming "People" to "Crew"/)).toBeVisible();
  // Names the dependent rather than only counting it — a count gives the user
  // nothing to go and check.
  await expect(host.getByText(/1 projection \("Staff"\)/)).toBeVisible();

  await host.getByRole('button', { name: 'No', exact: true }).click();

  // Cancelling writes nothing at all — neither the rename nor the re-point.
  await expect
    .poll(async () =>
      page.evaluate(
        async (id) =>
          (
            await (
              window as {
                __easydb?: { store: { tables: { findOne(i: string): Promise<{ name: string }> } } };
              }
            ).__easydb!.store.tables.findOne(id)
          ).name,
        peopleId,
      ),
    )
    .toBe('People');
  expect(await sourceNames(page, projId)).toEqual(['People', 'Dept']);
});

test('confirming the rename re-points the projection so it keeps resolving', async ({ page }) => {
  const { peopleId, projId } = await setup(page);
  expect(await projectionRows(page, projId)).toEqual([{ who: 'Alice', dept: 'Sales' }]);

  await renameTo(page, peopleId, 'Crew');
  await page.locator('host-dialogs').getByRole('button', { name: 'Yes', exact: true }).click();

  await expect.poll(async () => sourceNames(page, projId)).toEqual(['Crew', 'Dept']);
  // The point of re-pointing: the projection still computes its rows.
  await expect.poll(async () => projectionRows(page, projId)).toEqual([{ who: 'Alice', dept: 'Sales' }]);
});

test('renaming a table nothing references saves without a warning', async ({ page }) => {
  const orphan = await createTable(page, 'Orphan', [{ field: 'a' }]);
  await waitForPanel(page, orphan);

  await renameTo(page, orphan, 'Renamed');

  await expect(page.locator('new-table-dialog dialog')).toBeHidden();
  await expect(page.locator('host-dialogs').getByText(/Renaming/)).toHaveCount(0);
});

test('editing columns without touching the name never warns', async ({ page }) => {
  const { peopleId } = await setup(page);

  await page
    .locator(`#${panelDomId(peopleId)}`)
    .locator('panel-footer')
    .getByRole('button', { name: /Columns/ })
    .click();
  const dlg = page.locator('new-table-dialog dialog');
  await expect(dlg).toBeVisible();
  // Change a COLUMN label, leaving the table name alone.
  await dlg.locator('.col-row input[title^="Label"]').first().fill('Full Name');
  await dlg.getByRole('button', { name: 'Save', exact: true }).click();

  await expect(dlg).toBeHidden();
  await expect(page.locator('host-dialogs').getByText(/Renaming/)).toHaveCount(0);
});

/** Open the columns editor for a table and rename column `n`'s FIELD. */
async function renameField(page: import('@playwright/test').Page, tableId: string, n: number, next: string) {
  // Panels stack in creation order, so the one under test can sit beneath
  // another and its footer button be unclickable. The footer's own Columns
  // button fires this event, so ask the shell directly.
  await page.evaluate((id) => {
    document.dispatchEvent(new CustomEvent('easydb:edit-columns', { detail: { tableId: id } }));
  }, tableId);
  const dlg = page.locator('new-table-dialog dialog');
  await expect(dlg).toBeVisible();
  // First text input of a `.col-row` is the field; the second is the label.
  await dlg.locator('.col-row').nth(n).locator('input[type="text"]').first().fill(next);
  await dlg.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(dlg).toBeHidden();
}

/** The projection's spec, for asserting what its fields and join now name. */
async function specOfProjection(page: import('@playwright/test').Page, projId: string) {
  return page.evaluate(async (id) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const t = await (window as any).__easydb.store.tables.findOne(id);
    return t.source.config as {
      sources: Array<{ alias: string; tableName: string; join?: { on: Array<{ field: string; eqAlias: string; eqField: string }> } }>;
      columns: Array<{ field: string; from: { kind: string; alias?: string; field?: string } }>;
    };
  }, projId);
}

/**
 * A projection names FIELDS as well as tables — its output fields, the source
 * fields it reads, and its join keys — and a rename has to carry those across
 * too. It did not, so a renamed column came out EMPTY: the projection kept
 * writing the old key into every row while the renamed column read the new one.
 */
test('renaming a column OF a projection keeps its values', async ({ page }) => {
  const { projId } = await setup(page);
  await waitForPanel(page, projId);
  await expect.poll(async () => (await projectionRows(page, projId))[0]?.who).toBe('Alice');

  await renameField(page, projId, 0, 'person');

  // The output field moved in the spec, so the computed row carries the new key.
  const spec = await specOfProjection(page, projId);
  expect(spec.columns[0]!.field).toBe('person');
  // What it READS is untouched — only the output name changed.
  expect(spec.columns[0]!.from).toMatchObject({ alias: 'p', field: 'name' });
  await expect.poll(async () => (await projectionRows(page, projId))[0]?.person).toBe('Alice');
});

test('renaming a field of a SOURCE table keeps the projection reading it', async ({ page }) => {
  const { peopleId, projId } = await setup(page);
  await expect.poll(async () => (await projectionRows(page, projId))[0]?.who).toBe('Alice');

  // People.name → People.fullName. The projection reads `p.name`.
  await renameField(page, peopleId, 0, 'fullName');

  const spec = await specOfProjection(page, projId);
  expect(spec.columns[0]!.from).toMatchObject({ alias: 'p', field: 'fullName' });
  await expect.poll(async () => (await projectionRows(page, projId))[0]?.who).toBe('Alice');
});

test('renaming a JOIN key on either side keeps the join matching', async ({ page }) => {
  const { peopleId, deptId, projId } = await setup(page);
  await expect.poll(async () => (await projectionRows(page, projId))[0]?.dept).toBe('Sales');

  // The join is Dept.id = People.deptId. Rename both sides, one save each.
  await renameField(page, deptId, 0, 'deptKey');
  await renameField(page, peopleId, 1, 'department');

  const spec = await specOfProjection(page, projId);
  expect(spec.sources[1]!.join!.on[0]).toEqual({ field: 'deptKey', eqAlias: 'p', eqField: 'department' });
  // Still joined, so the joined column still carries its value.
  await expect.poll(async () => (await projectionRows(page, projId))[0]?.dept).toBe('Sales');
});
