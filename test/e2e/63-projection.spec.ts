import { test, expect } from './fixtures.js';
import { addRow, bulkAddRows, createTable, panelDomId, readRows, readTable, waitForPanel } from './helpers.js';

/**
 * Projections — virtual tables whose rows are derived (a database view / JOIN)
 * from other tables. They are ordinary Tables carrying
 * `source: { type: 'projection', config: ProjectionSpec }`, so they open in a
 * window and behave like tables; the `projection` provider computes their rows.
 */

/** Insert a projection table directly (what the editor's onSave compiles to). */
async function createProjection(page: import('@playwright/test').Page, peopleId: string, deptId: string): Promise<string> {
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
              { field: 'name', from: { kind: 'source', alias: 'p', field: 'name' } },
              { field: 'dept', from: { kind: 'source', alias: 'd', field: 'label' } },
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
  test('a projection joins its sources, and BOTH the base and joined columns are editable', async ({ page }) => {
    const peopleId = await createTable(page, 'People', [{ field: 'name' }, { field: 'deptId' }]);
    const deptId = await createTable(page, 'Dept', [{ field: 'id' }, { field: 'label' }]);
    await bulkAddRows(page, peopleId, [{ name: 'Bob', deptId: 'd1' }]);
    await bulkAddRows(page, deptId, [{ id: 'd1', label: 'Sales' }]);

    const projId = await createProjection(page, peopleId, deptId);
    await waitForPanel(page, projId);
    const panel = page.locator(`#${panelDomId(projId)}`);

    // BOTH cells get an editor — so the joined value is shown by its input's
    // value, not as a text node. The join knows which row each value came from,
    // so there is nothing ambiguous about writing either of them back.
    const inputs = panel.locator('data-table tbody tr td input');
    await expect(inputs).toHaveCount(2);
    await expect(inputs.nth(0)).toHaveValue('Bob');
    await expect(inputs.nth(1)).toHaveValue('Sales');

    // Editing the base column writes back to the underlying People row.
    await inputs.nth(0).fill('Robert');
    await inputs.nth(0).dispatchEvent('change');
    await expect.poll(async () => (await readRows(page, peopleId))[0]?.data.name).toBe('Robert');

    // Editing the JOINED column writes back to the Dept row it came from —
    // and leaves People alone.
    await panel.locator('data-table tbody tr td input').nth(1).fill('Revenue');
    await panel.locator('data-table tbody tr td input').nth(1).dispatchEvent('change');
    await expect.poll(async () => (await readRows(page, deptId))[0]?.data.label).toBe('Revenue');
    expect((await readRows(page, peopleId))[0]?.data.name).toBe('Robert');
  });

  test('Edit columns opens the ordinary column editor; Edit Join opens the join editor', async ({ page }) => {
    const peopleId = await createTable(page, 'People', [{ field: 'name' }, { field: 'deptId' }]);
    const deptId = await createTable(page, 'Dept', [{ field: 'id' }, { field: 'label' }]);
    await bulkAddRows(page, peopleId, [{ name: 'Bob', deptId: 'd1' }]);
    await bulkAddRows(page, deptId, [{ id: 'd1', label: 'Sales' }]);
    const projId = await createProjection(page, peopleId, deptId);
    await waitForPanel(page, projId);
    const footer = page.locator(`#${panelDomId(projId)}`);

    // "Edit columns" → the SAME editor tables use, and saving it sticks.
    await footer.getByRole('button', { name: 'Columns' }).click();
    const colEditor = page.locator('new-table-dialog dialog');
    await expect(colEditor).toBeVisible();
    const labelInput = page.locator('new-table-dialog .col-row input[title^="Label"]').first();
    await labelInput.fill('Renamed by hand');
    await page.locator('new-table-dialog').getByRole('button', { name: 'Save', exact: true }).click();
    await expect(colEditor).toBeHidden();
    await expect
      .poll(async () => {
        const t = await readTable(page, projId);
        return (t as { columns: Array<{ label: string }> }).columns.map((c) => c.label);
      })
      .toContain('Renamed by hand');

    // "Edit Join" → the projection editor, a separate button.
    await footer.getByRole('button', { name: 'Edit Join' }).click();
    await expect(page.locator('projection-dialog dialog')).toBeVisible();
  });

  test('Edit Join offers source fields the projection left out, and adding one inherits its settings', async ({ page }) => {
    const peopleId = await createTable(page, 'People', [{ field: 'name' }, { field: 'deptId' }]);
    const deptId = await createTable(page, 'Dept', [{ field: 'id' }, { field: 'label' }]);
    await bulkAddRows(page, peopleId, [{ name: 'Bob', deptId: 'd1' }]);
    await bulkAddRows(page, deptId, [{ id: 'd1', label: 'Sales' }]);
    // Give Dept's `id` a distinctive setting to prove inheritance on add.
    await page.evaluate(async (id) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ctx = (window as any).__easydb;
      const t = await ctx.store.tables.findOne(id);
      await ctx.store.tables.patch(id, {
        columns: t.columns.map((c: { field: string }) => (c.field === 'id' ? { ...c, label: 'Dept code', renderer: 'link', width: 175 } : c)),
        updatedAt: Date.now(),
      });
    }, deptId);

    // The projection selects People.name and Dept.label — NOT Dept.id.
    const projId = await createProjection(page, peopleId, deptId);
    await waitForPanel(page, projId);
    await page
      .locator(`#${panelDomId(projId)}`)
      .getByRole('button', { name: 'Edit Join' })
      .click();
    const dialog = page.locator('projection-dialog');
    await expect(dialog.locator('dialog')).toBeVisible();

    // Every source field is offered, including the unselected `id` and `deptId`.
    const unticked = dialog.locator('label.tick input:not(:checked)');
    await expect(unticked).toHaveCount(2);
    // Exact match: a substring "id" would also hit People's "deptId" pill.
    await dialog.locator('label.tick:has(.tick-name:text-is("id"))').locator('input').check();
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();

    // The added column arrives with the source column's own settings copied.
    await expect
      .poll(async () => {
        const t = (await readTable(page, projId)) as {
          columns: Array<{ field: string; label: string; renderer?: string; width?: number }>;
        };
        return t.columns.find((c) => c.label === 'Dept code') ?? null;
      })
      .toMatchObject({ label: 'Dept code', renderer: 'link', width: 175 });
  });

  test('a row limit caps the projection', async ({ page }) => {
    const id = await createTable(page, 'Many', [{ field: 'name' }]);
    await bulkAddRows(page, id, [{ name: 'a' }, { name: 'b' }, { name: 'c' }, { name: 'd' }, { name: 'e' }]);
    await waitForPanel(page, id);

    await page
      .locator(`#${panelDomId(id)}`)
      .getByRole('button', { name: 'New Projection' })
      .click();
    const dialog = page.locator('projection-dialog');
    await expect(dialog.locator('dialog')).toBeVisible();
    await dialog.locator('#proj-name').fill('Top two');
    await dialog.locator('#proj-limit').fill('2');
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();

    await expect
      .poll(() =>
        page.evaluate(async () => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const ctx = (window as any).__easydb;
          const all = await ctx.store.tables.find({ workspaceId: ctx.workspaceId });
          const p = all.find((t: { source?: { type?: string }; name: string }) => t.source?.type === 'projection' && t.name === 'Top two');
          if (!p) return null;
          return {
            limit: (p.source.config as { limit?: number }).limit,
            rows: (await ctx.store.rows(p.id).find()).length,
          };
        }),
      )
      .toEqual({ limit: 2, rows: 2 });
  });

  test('the New Projection button creates a working projection through the editor', async ({ page }) => {
    const soloId = await createTable(page, 'Solo', [{ field: 'name' }]);
    await addRow(page, soloId, { name: 'only-row' });
    await waitForPanel(page, soloId);

    // New Projection is a per-table footer button: launching it from Solo makes
    // Solo the base, so no source picking is needed for a single-source view.
    await page
      .locator(`#${panelDomId(soloId)}`)
      .getByRole('button', { name: 'New Projection' })
      .click();

    const dialog = page.locator('projection-dialog');
    await expect(dialog.locator('dialog')).toBeVisible();
    // Base source (the only candidate) is auto-seeded with its columns selected.
    await dialog.locator('#proj-name').fill('Solo view');
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();

    // A projection table was created and its provider computes the source rows.
    // Poll: the Save → insert → compute chain settles asynchronously.
    await expect
      .poll(() =>
        page.evaluate(async () => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const ctx = (window as any).__easydb;
          const all = await ctx.store.tables.find({ workspaceId: ctx.workspaceId });
          const p = all.find((t: { source?: { type?: string }; name: string }) => t.source?.type === 'projection' && t.name === 'Solo view');
          if (!p) return null;
          const rows = await ctx.store.rows(p.id).find();
          return rows.map((r: { data: Record<string, unknown> }) => r.data);
        }),
      )
      .toEqual([{ name: 'only-row' }]);
  });

  test("inherits the base table's hidden columns, sort and filters", async ({ page }) => {
    const id = await createTable(page, 'Staff', [{ field: 'name' }, { field: 'dept' }, { field: 'rowid' }]);
    await bulkAddRows(page, id, [
      { name: 'Bob', dept: 'Sales', rowid: 1 },
      { name: 'Ann', dept: 'Support', rowid: 2 },
    ]);
    // The user hides a column, sorts, and filters the ordinary table.
    await page.evaluate(async (tableId) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ctx = (window as any).__easydb;
      const t = await ctx.store.tables.findOne(tableId);
      await ctx.store.tables.patch(tableId, {
        columns: t.columns.map((c: { field: string }) => (c.field === 'dept' ? { ...c, hidden: true } : c)),
        sortBy: [{ field: 'name', asc: true }],
        sortColumn: 'name',
        sortAsc: true,
        filters: { name: 'B' },
        updatedAt: Date.now(),
      });
    }, id);
    await waitForPanel(page, id);

    await page
      .locator(`#${panelDomId(id)}`)
      .getByRole('button', { name: 'New Projection' })
      .click();
    const dialog = page.locator('projection-dialog');
    await expect(dialog.locator('dialog')).toBeVisible();
    await dialog.locator('#proj-name').fill('Staff view');
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();

    const readProj = () =>
      page.evaluate(async () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const ctx = (window as any).__easydb;
        const all = await ctx.store.tables.find({ workspaceId: ctx.workspaceId });
        return all.find((t: { source?: { type?: string }; name: string }) => t.source?.type === 'projection' && t.name === 'Staff view') ?? null;
      });
    // Save → inherit columns → insert settles over a couple of ticks.
    await expect.poll(async () => Boolean(await readProj())).toBe(true);
    const proj = await readProj();

    // Hidden column and rowid both carried over as hidden; sort + filter copied.
    const hidden = (proj.columns as Array<{ field: string; hidden?: boolean }>)
      .filter((c) => c.hidden)
      .map((c) => c.field)
      .sort();
    expect(hidden).toEqual(['dept', 'rowid']);
    expect(proj.sortBy).toEqual([{ field: 'name', asc: true }]);
    expect(proj.filters).toEqual({ name: 'B' });
  });

  test('joins the same table twice (similarities → til → til)', async ({ page }) => {
    // Simon Willison's TIL shape: `similarities` references `til` twice.
    const tilId = await createTable(page, 'til', [{ field: 'path' }, { field: 'title' }]);
    await bulkAddRows(page, tilId, [
      { path: 'a.md', title: 'Apache bench' },
      { path: 'b.md', title: 'Escaping SQL' },
    ]);
    // `path` is til's key — mark it so the join heuristic can pair it.
    await page.evaluate(async (id) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ctx = (window as any).__easydb;
      const t = await ctx.store.tables.findOne(id);
      await ctx.store.tables.patch(id, {
        columns: t.columns.map((c: { field: string }) => (c.field === 'path' ? { ...c, unique: true } : c)),
        updatedAt: Date.now(),
      });
    }, tilId);
    const simId = await createTable(page, 'similarities', [{ field: 'id' }, { field: 'other_id' }, { field: 'score' }]);
    await bulkAddRows(page, simId, [{ id: 'a.md', other_id: 'b.md', score: 0.74 }]);
    await waitForPanel(page, simId);

    await page
      .locator(`#${panelDomId(simId)}`)
      .getByRole('button', { name: 'New Projection' })
      .click();
    const dialog = page.locator('projection-dialog');
    await expect(dialog.locator('dialog')).toBeVisible();
    // Add `til` TWICE — no join keys touched, so the heuristic must pick both.
    for (let i = 0; i < 2; i++) {
      await dialog.locator('#add-src').selectOption({ label: 'til' });
      await dialog.getByRole('button', { name: '+ Join table' }).click();
    }
    await dialog.locator('#proj-name').fill('Similar TILs');
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();

    await expect
      .poll(() =>
        page.evaluate(async () => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const ctx = (window as any).__easydb;
          const all = await ctx.store.tables.find({ workspaceId: ctx.workspaceId });
          const p = all.find((t: { source?: { type?: string }; name: string }) => t.source?.type === 'projection' && t.name === 'Similar TILs');
          if (!p) return null;
          const rows = await ctx.store.rows(p.id).find();
          return rows.map((r: { data: Record<string, unknown> }) => r.data);
        }),
      )
      // Both sides of the self-join resolved: the TIL and its similar TIL. New
      // columns are named after their SOURCE field, so the repeat is `title_2`.
      .toEqual([expect.objectContaining({ title: 'Apache bench', title_2: 'Escaping SQL' })]);
  });

  test('adding a join preselects sensible keys, so the join works without picking fields', async ({ page }) => {
    // Create Dept first, People last, so People's panel is on top and its
    // footer button isn't covered by another window.
    const deptId = await createTable(page, 'Dept', [{ field: 'id' }, { field: 'label' }]);
    await bulkAddRows(page, deptId, [{ id: 'd1', label: 'Sales' }]);
    const peopleId = await createTable(page, 'People', [{ field: 'name' }, { field: 'deptId' }]);
    await bulkAddRows(page, peopleId, [{ name: 'Alice', deptId: 'd1' }]);
    await waitForPanel(page, peopleId);

    // Launch from People (the base), add Dept as a join, and Save WITHOUT ever
    // touching the join-key selects — the heuristic must have preselected them
    // (People.deptId = Dept.id), or buildSpec would reject the blank keys.
    await page
      .locator(`#${panelDomId(peopleId)}`)
      .getByRole('button', { name: 'New Projection' })
      .click();
    const dialog = page.locator('projection-dialog');
    await expect(dialog.locator('dialog')).toBeVisible();
    await dialog.locator('#add-src').selectOption({ label: 'Dept' });
    await dialog.getByRole('button', { name: '+ Join table' }).click();
    await dialog.locator('#proj-name').fill('Staff');
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();

    await expect
      .poll(() =>
        page.evaluate(async () => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const ctx = (window as any).__easydb;
          const all = await ctx.store.tables.find({ workspaceId: ctx.workspaceId });
          const p = all.find((t: { source?: { type?: string }; name: string }) => t.source?.type === 'projection' && t.name === 'Staff');
          if (!p) return null;
          const rows = await ctx.store.rows(p.id).find();
          return rows.map((r: { data: Record<string, unknown> }) => r.data);
        }),
      )
      // The join resolved Alice → Sales purely from the preselected keys.
      .toEqual([expect.objectContaining({ name: 'Alice', label: 'Sales' })]);
  });
});
