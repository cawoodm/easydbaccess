import { test, expect } from './fixtures.js';
import {
  addRow,
  createTable,
  panelDomId,
  readRows,
  readTable,
  waitForPanel,
} from './helpers.js';

/**
 * TODO § Import / export
 * - CSV paste dialog (textarea path)
 * - CSV header mini-language (field:label:type:default:max:flags)
 * - CSV import-mode dialog when a same-named table already exists
 * - JSON import-mode dialog (replace / overwrite-matching / append)
 * - cascade window positions for tables without saved coords
 * - dump-export → json-import round trip is lossless
 */

/** Inject a synthetic file-drop into the drop handler registry. */
async function dropFile(page: import('@playwright/test').Page, filename: string, text: string, type: string) {
  await page.evaluate(
    async ({ filename, text, type }) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ctx = (window as any).__easydb;
      const file = new File([text], filename, { type });
      const dt = new DataTransfer();
      dt.items.add(file);
      const event = new DragEvent('drop', { bubbles: true, dataTransfer: dt });
      for (const fn of ctx.registries.dropHandlers) {
        const handled = await fn(event, ctx.api);
        if (handled) break;
      }
    },
    { filename, text, type },
  );
}

test.describe('import / export', () => {
  test('CSV paste dialog creates a table from pasted text', async ({ page }) => {
    // Open the paste dialog via the chrome event hook.
    await page.evaluate(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).__easydb.api.ui.openCsvPasteDialog();
    });

    const dialog = page.locator('csv-paste-dialog dialog');
    await expect(dialog).toBeVisible();

    await dialog.locator('input[type="text"]').first().fill('From paste');
    await dialog.locator('textarea').fill('name,age\nAlice,30\nBob,25');
    await dialog.getByRole('button', { name: 'Import' }).click();
    await expect(dialog).toBeHidden();

    // Table now exists with two rows.
    const tables = await page.evaluate(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      () => (window as any).__easydb.store.tables.find(),
    );
    const t = (tables as Array<{ name: string }>).find((x) => x.name === 'From paste');
    expect(t).toBeTruthy();
    const rows = await page.evaluate(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (id) => (window as any).__easydb.store.rows(id).find(),
      (t as unknown as { id: string }).id,
    );
    expect(rows).toHaveLength(2);
  });

  test('CSV append maps cells to existing columns by index when header names differ', async ({
    page,
  }) => {
    // Existing table has fields [name, age]. CSV header is [Person Name, Years]
    // — names slugify to different strings (person_name, years), so the OLD
    // behavior dropped the data on the floor. Index-mapping must put column 0
    // into `name` and column 1 into `age`.
    const tableId = await createTable(page, 'mismatched', [
      { field: 'name' },
      { field: 'age', type: 'number' },
    ]);

    const dropPromise = dropFile(
      page,
      'mismatched.csv',
      'Person Name,Years\nAlice,30\nBob,25',
      'text/csv',
    );
    const dialog = page.locator('host-dialogs');
    await expect(dialog.getByRole('button', { name: 'Append rows' })).toBeVisible();
    await dialog.getByRole('button', { name: 'Append rows' }).click();
    await dropPromise;

    const rows = await readRows(page, tableId);
    expect(rows).toHaveLength(2);
    const sorted = [...rows].sort((a, b) =>
      String(a.data.name).localeCompare(String(b.data.name)),
    );
    expect(sorted[0]?.data).toEqual({ name: 'Alice', age: 30 });
    expect(sorted[1]?.data).toEqual({ name: 'Bob', age: 25 });
  });

  test('CSV overwrite preserves existing column definitions and maps by index', async ({
    page,
  }) => {
    // Existing table has fields [name, age] with width=200 on name. After
    // Overwrite, the column definitions must survive (width preserved) and
    // the CSV data must populate by position.
    const tableId = await createTable(page, 'preserve-schema', [
      { field: 'name' },
      { field: 'age', type: 'number' },
    ]);
    await addRow(page, tableId, { name: 'old', age: 1 });
    await page.evaluate(
      async (id) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const store = (window as any).__easydb.store;
        const t = await store.tables.findOne(id);
        t.columns[0].width = 200;
        await store.tables.patch(id, { columns: t.columns, updatedAt: Date.now() });
      },
      tableId,
    );

    const dropPromise = dropFile(
      page,
      'preserve-schema.csv',
      'WhateverHeader,SomethingElse\nCarol,40\nDan,50',
      'text/csv',
    );
    const dialog = page.locator('host-dialogs');
    await dialog.getByRole('button', { name: 'Overwrite rows' }).click();
    await dropPromise;

    const tbl = await readTable(page, tableId);
    expect(tbl.columns[0].field).toBe('name');
    expect(tbl.columns[0].width).toBe(200); // preserved
    expect(tbl.columns[1].field).toBe('age');

    const rows = await readRows(page, tableId);
    expect(rows).toHaveLength(2); // old row wiped, only CSV rows remain
    const sorted = [...rows].sort((a, b) =>
      String(a.data.name).localeCompare(String(b.data.name)),
    );
    expect(sorted[0]?.data).toEqual({ name: 'Carol', age: 40 });
    expect(sorted[1]?.data).toEqual({ name: 'Dan', age: 50 });
  });

  test('CSV header mini-language parses field:label:type into ColumnSpec', async ({ page }) => {
    await page.evaluate(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).__easydb.api.ui.openCsvPasteDialog();
    });
    const dialog = page.locator('csv-paste-dialog dialog');
    await dialog.locator('input[type="text"]').first().fill('Specced');
    await dialog
      .locator('textarea')
      .fill('id:Order ID:number,paid:Paid?:boolean\n1,true\n2,false');
    await dialog.getByRole('button', { name: 'Import' }).click();
    await expect(dialog).toBeHidden();

    const t = await page.evaluate(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const tables = await (window as any).__easydb.store.tables.find();
        return tables.find((x: { name: string }) => x.name === 'Specced');
      },
    );
    expect(t.columns[0]).toMatchObject({ field: 'id', label: 'Order ID', type: 'number' });
    expect(t.columns[1]).toMatchObject({ field: 'paid', label: 'Paid?', type: 'boolean' });
  });

  test('CSV drop onto existing table name opens the import-mode choice dialog', async ({ page }) => {
    // Pre-existing table named "people".
    await createTable(page, 'people', [{ field: 'name' }]);
    await addRow(page, '', {}); // no-op; just ensures __easydb is ready

    const dropPromise = dropFile(page, 'people.csv', 'name\nCarol\nDan', 'text/csv');

    const dialog = page.locator('host-dialogs');
    await expect(dialog.getByText(/already exists/i)).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Append rows' })).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Overwrite rows' })).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Create as new table' })).toBeVisible();
    // Pick Append.
    await dialog.getByRole('button', { name: 'Append rows' }).click();
    await dropPromise;

    const tables = await page.evaluate(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      () => (window as any).__easydb.store.tables.find(),
    );
    const people = (tables as Array<{ name: string; id: string }>).find((x) => x.name === 'people');
    const rows = await page.evaluate(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (id) => (window as any).__easydb.store.rows(id).find(),
      people!.id,
    );
    expect(rows).toHaveLength(2); // Carol + Dan
  });

  test('JSON drop with existing tables opens the import-mode choice dialog', async ({ page }) => {
    // Pre-existing table whose name collides with the dump's first table.
    await createTable(page, 'people', [{ field: 'name' }]);

    const dump = JSON.stringify({
      workspaceId: 'whatever',
      exportedAt: Date.now(),
      tables: [
        {
          name: 'people',
          columns: [{ field: 'name', label: 'Name', type: 'string' }],
          rows: [{ name: 'Erin' }, { name: 'Frank' }],
        },
        {
          name: 'pets',
          columns: [{ field: 'species', label: 'Species', type: 'string' }],
          rows: [{ species: 'cat' }],
        },
      ],
    });
    const dropPromise = dropFile(page, 'dump.db.json', dump, 'application/json');

    const dialog = page.locator('host-dialogs');
    await expect(dialog.getByText(/Importing 2 tables/i)).toBeVisible();
    await expect(dialog.getByRole('button', { name: /Overwrite matching/ })).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Replace entire workspace' })).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Add as new tables' })).toBeVisible();

    await dialog.getByRole('button', { name: /Overwrite matching/ }).click();
    await dropPromise;

    // people now has 2 rows (overwritten); pets table was added.
    const tables = await page.evaluate(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      () => (window as any).__easydb.store.tables.find(),
    );
    const people = (tables as Array<{ name: string; id: string }>).find((x) => x.name === 'people')!;
    const pets = (tables as Array<{ name: string; id: string }>).find((x) => x.name === 'pets')!;
    expect(people).toBeTruthy();
    expect(pets).toBeTruthy();
    const peopleRows = await readRows(page, people.id);
    expect(peopleRows).toHaveLength(2);
  });

  test('cascade positions imported tables without elementRect coords', async ({ page }) => {
    // Drop a dump with two tables, neither carrying windowGeometry → they
    // should land at different cascade positions, not stacked at 0,0.
    const dump = JSON.stringify({
      workspaceId: 'x',
      exportedAt: 1,
      tables: [
        {
          name: 'one',
          columns: [{ field: 'a', label: 'A', type: 'string' }],
          rows: [{ a: '1' }],
        },
        {
          name: 'two',
          columns: [{ field: 'b', label: 'B', type: 'string' }],
          rows: [{ b: '2' }],
        },
      ],
    });
    const dropPromise = dropFile(page, 'cascade.db.json', dump, 'application/json');
    // First table has no collision so json-import skips the prompt; but
    // it sees a multi-table dump → still prompts. Pick "Add to current workspace".
    const dialog = page.locator('host-dialogs');
    await expect(dialog.getByText(/Importing 2 tables/i)).toBeVisible();
    await dialog.getByRole('button', { name: 'Add to current workspace' }).click();
    await dropPromise;

    const tables = await page.evaluate(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      () => (window as any).__easydb.store.tables.find(),
    );
    const one = (tables as Array<{ name: string; id: string }>).find((x) => x.name === 'one')!;
    const two = (tables as Array<{ name: string; id: string }>).find((x) => x.name === 'two')!;
    await waitForPanel(page, one.id);
    await waitForPanel(page, two.id);

    // Panels at different left/top positions — jsPanel cascade staggers them.
    const positions = await page.evaluate(
      ({ a, b }) => {
        const ea = document.getElementById(a)!;
        const eb = document.getElementById(b)!;
        return {
          a: { left: ea.offsetLeft, top: ea.offsetTop },
          b: { left: eb.offsetLeft, top: eb.offsetTop },
        };
      },
      { a: panelDomId(one.id), b: panelDomId(two.id) },
    );
    expect(positions.a).not.toEqual(positions.b);
  });

  test('JSON drop with Replace entire workspace wipes all existing tables and rows first', async ({
    page,
    workspaceId,
  }) => {
    // Pre-existing tables that should be GONE after the replace.
    const aId = await createTable(page, 'alpha', [{ field: 'name' }]);
    await addRow(page, aId, { name: 'one' });
    await addRow(page, aId, { name: 'two' });
    const bId = await createTable(page, 'bravo', [{ field: 'tag' }]);
    await addRow(page, bId, { tag: 'x' });

    // Imported dump has no name collisions — Replace should still nuke alpha+bravo.
    const dump = JSON.stringify({
      workspaceId: 'whatever',
      exportedAt: Date.now(),
      tables: [
        {
          name: 'gamma',
          columns: [{ field: 'val', label: 'Val', type: 'string' }],
          rows: [{ val: 'g1' }, { val: 'g2' }],
        },
        {
          name: 'delta',
          columns: [{ field: 'val', label: 'Val', type: 'string' }],
          rows: [{ val: 'd1' }],
        },
      ],
    });
    const dropPromise = dropFile(page, 'replace.db.json', dump, 'application/json');
    const dialog = page.locator('host-dialogs');
    await expect(dialog.getByRole('button', { name: 'Replace entire workspace' })).toBeVisible();
    await dialog.getByRole('button', { name: 'Replace entire workspace' }).click();
    await dropPromise;

    const tables = await page.evaluate(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      () => (window as any).__easydb.store.tables.find(),
    );
    const inWorkspace = (tables as Array<{ name: string; workspaceId: string }>).filter(
      (t) => t.workspaceId === workspaceId,
    );
    expect(inWorkspace.map((t) => t.name).sort()).toEqual(['delta', 'gamma']);

    // And no orphan rows belonging to the wiped tables remain in the rows coll.
    const orphanRows = await page.evaluate(
      ([wipedA, wipedB]) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const store = (window as any).__easydb.store;
        return Promise.all([store.rows(wipedA).find(), store.rows(wipedB).find()]).then(
          ([ra, rb]: [unknown[], unknown[]]) => ra.length + rb.length,
        );
      },
      [aId, bId] as const,
    );
    expect(orphanRows).toBe(0);

    // The jsPanel windows for the wiped tables must close too.
    await expect(page.locator(`#${panelDomId(aId)}`)).toHaveCount(0);
    await expect(page.locator(`#${panelDomId(bId)}`)).toHaveCount(0);
  });

  test('dump-export → json-import is lossless for columns + rows', async ({ page }) => {
    // Build two tables with distinct schemas + rows.
    const idA = await createTable(page, 'Alpha', [
      { field: 'name' },
      { field: 'qty', type: 'number' },
    ]);
    await addRow(page, idA, { name: 'apple', qty: 3 });
    await addRow(page, idA, { name: 'pear', qty: 7 });
    const idB = await createTable(page, 'Bravo', [{ field: 'tag' }]);
    await addRow(page, idB, { tag: 'green' });

    // Serialize the workspace (same path the Dump footer button uses).
    const serialized: string = await page.evaluate(async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const mod = await import('/src/plugins/dump-export.js');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return mod.serializeWorkspace((window as any).__easydb.api);
    });
    expect(serialized).toContain('Alpha');
    expect(serialized).toContain('Bravo');
    // Make sure both tables actually serialized — guards against a partial
    // dump letting the test pass for the wrong reason later.
    const parsed = JSON.parse(serialized) as { tables: Array<{ name: string }> };
    expect(parsed.tables.map((t) => t.name).sort()).toEqual(['Alpha', 'Bravo']);

    // Don't wipe — closing panels would fire jspanel-manager's "Delete?"
    // confirm dialog and clash with the import prompt. Instead, navigate to
    // a fresh workspace, which gives us an empty target without touching
    // the source workspace's panels.
    const targetWs = `import-target-${Math.random().toString(36).slice(2, 8)}`;
    await page.goto(`/?test=1&space=${encodeURIComponent(targetWs)}`);
    await page.waitForFunction(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      () => Boolean((window as any).__easydb),
    );
    const before = await page.evaluate(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      () => (window as any).__easydb.store.tables.find(),
    );
    expect(
      (before as Array<{ workspaceId: string }>).filter((t) => t.workspaceId === targetWs),
    ).toHaveLength(0);

    // Round-trip: drop the dump back in. Multi-table → choice dialog appears.
    const dropPromise = dropFile(page, 'round.db.json', serialized, 'application/json');
    const dialog = page.locator('host-dialogs');
    await expect(dialog.getByText(/Importing 2 tables/i)).toBeVisible();
    await dialog.getByRole('button', { name: 'Add to current workspace' }).click();
    await dropPromise;

    const tables = await page.evaluate(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      () => (window as any).__easydb.store.tables.find(),
    );
    const alpha = (tables as Array<{ name: string; id: string }>).find((x) => x.name === 'Alpha')!;
    const bravo = (tables as Array<{ name: string; id: string }>).find((x) => x.name === 'Bravo')!;
    const alphaRows = await readRows(page, alpha.id);
    const bravoRows = await readRows(page, bravo.id);
    expect(alphaRows).toHaveLength(2);
    expect(bravoRows).toHaveLength(1);
    expect(
      alphaRows.map((r: { data: { name: unknown } }) => r.data.name).sort(),
    ).toEqual(['apple', 'pear']);
    expect(bravoRows[0]?.data.tag).toBe('green');
  });
});
