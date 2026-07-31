import { test, expect } from './fixtures.js';
import { addRow, bulkAddRows, createTable, panelDomId, readRows, waitForPanel } from './helpers.js';

/**
 * Projections — virtual tables whose rows are derived (a database view / JOIN)
 * from other tables. They are ordinary Tables carrying
 * `source: { type: 'projection', config: ProjectionSpec }`, so they open in a
 * window and behave like tables; the `projection` provider computes their rows.
 */

/** Insert a projection table directly (what the editor's onSave compiles to). */
async function createProjection(
  page: import('@playwright/test').Page,
  peopleId: string,
  deptId: string,
): Promise<string> {
  return page.evaluate(
    async ({ peopleId, deptId }) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ctx = (window as any).__easydb;
      const id = crypto.randomUUID();
      await ctx.store.tables.insert({
        id,
        workspaceId: ctx.workspaceId,
        name: 'People + Dept',
        code: 'people-dept',
        view: 'table',
        // name is a writable base-source column; dept is a read-only
        // secondary-source column (joined in, no unambiguous write target).
        columns: [
          { field: 'name', label: 'Name', type: 'string' },
          { field: 'dept', label: 'Dept', type: 'string', readonly: true },
        ],
        source: {
          type: 'projection',
          config: {
            version: 1,
            sources: [
              { alias: 'p', tableName: 'People', tableId: peopleId },
              {
                alias: 'd',
                tableName: 'Dept',
                tableId: deptId,
                join: { type: 'left', on: [{ field: 'id', eqAlias: 'p', eqField: 'deptId' }] },
              },
            ],
            columns: [
              { field: 'name', label: 'Name', type: 'string', from: { kind: 'source', alias: 'p', field: 'name' } },
              { field: 'dept', label: 'Dept', type: 'string', from: { kind: 'source', alias: 'd', field: 'label' } },
            ],
          },
        },
        updatedAt: Date.now(),
      });
      return id as string;
    },
    { peopleId, deptId },
  );
}

test.describe('projections', () => {
  test('a projection joins its sources, edits its base column, and locks the joined column', async ({
    page,
  }) => {
    const peopleId = await createTable(page, 'People', [{ field: 'name' }, { field: 'deptId' }]);
    const deptId = await createTable(page, 'Dept', [{ field: 'id' }, { field: 'label' }]);
    await bulkAddRows(page, peopleId, [{ name: 'Bob', deptId: 'd1' }]);
    await bulkAddRows(page, deptId, [{ id: 'd1', label: 'Sales' }]);

    const projId = await createProjection(page, peopleId, deptId);
    await waitForPanel(page, projId);
    const panel = page.locator(`#${panelDomId(projId)}`);

    // The joined value shows, and the base value shows.
    await expect(panel.getByText('Sales')).toBeVisible();

    // Exactly one editable input in the row: the base-source `name`. The
    // read-only `dept` renders as plain text (no editor).
    const inputs = panel.locator('data-table tbody tr td input');
    await expect(inputs).toHaveCount(1);
    await expect(inputs.first()).toHaveValue('Bob');

    // Editing the base column writes back to the underlying People row.
    await inputs.first().fill('Robert');
    await inputs.first().dispatchEvent('change');
    await expect
      .poll(async () => (await readRows(page, peopleId))[0]?.data.name)
      .toBe('Robert');

    // The joined column is still just text — no input carrying 'Sales'.
    await expect(panel.locator('data-table tbody tr td input')).toHaveCount(1);
  });

  test('the New Projection button creates a working projection through the editor', async ({
    page,
  }) => {
    const soloId = await createTable(page, 'Solo', [{ field: 'name' }]);
    await addRow(page, soloId, { name: 'only-row' });
    await waitForPanel(page, soloId);

    // New Projection is a per-table footer button: launching it from Solo makes
    // Solo the base, so no source picking is needed for a single-source view.
    await page.locator(`#${panelDomId(soloId)}`).getByRole('button', { name: 'New Projection' }).click();

    const dialog = page.locator('projection-dialog');
    await expect(dialog.locator('dialog')).toBeVisible();
    // Base source (the only candidate) is auto-seeded with its columns selected.
    await dialog.locator('input').first().fill('Solo view');
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();

    // A projection table was created and its provider computes the source rows.
    // Poll: the Save → insert → compute chain settles asynchronously.
    await expect
      .poll(() =>
        page.evaluate(async () => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const ctx = (window as any).__easydb;
          const all = await ctx.store.tables.find({ workspaceId: ctx.workspaceId });
          const p = all.find(
            (t: { source?: { type?: string }; name: string }) =>
              t.source?.type === 'projection' && t.name === 'Solo view',
          );
          if (!p) return null;
          const rows = await ctx.store.rows(p.id).find();
          return rows.map((r: { data: Record<string, unknown> }) => r.data);
        }),
      )
      .toEqual([{ name: 'only-row' }]);
  });
});
