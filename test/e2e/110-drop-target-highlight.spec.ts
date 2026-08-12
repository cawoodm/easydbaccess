import { test, expect } from './fixtures.js';
import { bulkAddRows, createTable, panelDomId, readRows, readTable, waitForPanel } from './helpers.js';

/**
 * A drag says where it is about to land.
 *
 * Dropping a file on a table window LOADS that table; dropping it anywhere else
 * makes a new one. Both were already true, and nothing on screen said which was
 * about to happen: one overlay covered the whole canvas, table windows included, and
 * announced "Drop CSV or JSON here" over the very window whose behaviour differed.
 */

/** Dispatch a real `dragover`/`dragleave` carrying a file, from a given node. */
async function dragOver(page: import('@playwright/test').Page, selector: string) {
  await page.evaluate((sel) => {
    const node = sel === 'canvas' ? document.body : document.querySelector(sel);
    if (!node) throw new Error(`no node for ${sel}`);
    const dt = new DataTransfer();
    dt.items.add(new File(['a,b\n1,2'], 'x.csv', { type: 'text/csv' }));
    node.dispatchEvent(new DragEvent('dragover', { bubbles: true, dataTransfer: dt }));
  }, selector);
}

async function dragLeaveApp(page: import('@playwright/test').Page) {
  await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.items.add(new File(['a'], 'x.csv', { type: 'text/csv' }));
    // `relatedTarget` null ⇒ the pointer left the window entirely.
    document.body.dispatchEvent(new DragEvent('dragleave', { bubbles: true, dataTransfer: dt }));
  });
}

const marks = (page: import('@playwright/test').Page, tableId: string) =>
  page.evaluate(
    (domId) => ({
      workspace: document.querySelector('app-shell')?.classList.contains('drag-over') ?? false,
      panel: document.getElementById(domId)?.classList.contains('eda-drop-target') ?? false,
    }),
    panelDomId(tableId),
  );

test('dragging over a table window highlights the window, not the workspace', async ({ page }) => {
  const id = await createTable(page, 'people', [{ field: 'name', renderer: 'link' }]);
  await waitForPanel(page, id);

  await dragOver(page, `#${panelDomId(id)}`);
  expect(await marks(page, id)).toEqual({ workspace: false, panel: true });
});

test('dragging over the canvas highlights the workspace, not any window', async ({ page }) => {
  const id = await createTable(page, 'people', [{ field: 'name', renderer: 'link' }]);
  await waitForPanel(page, id);

  await dragOver(page, 'canvas');
  expect(await marks(page, id)).toEqual({ workspace: true, panel: false });
});

test('the highlight moves with the pointer and clears when the drag leaves', async ({ page }) => {
  const id = await createTable(page, 'people', [{ field: 'name', renderer: 'link' }]);
  await waitForPanel(page, id);

  await dragOver(page, `#${panelDomId(id)}`);
  expect(await marks(page, id)).toEqual({ workspace: false, panel: true });
  // Back out onto the canvas: at most one target is ever marked.
  await dragOver(page, 'canvas');
  expect(await marks(page, id)).toEqual({ workspace: true, panel: false });
  await dragLeaveApp(page);
  expect(await marks(page, id)).toEqual({ workspace: false, panel: false });
});

/**
 * A drop ON a window says where the data goes, not which part of the file it is. So a
 * file of several tables leaves one question open, and it is answered the way a
 * person would: a table of the same name is the one meant, and only a file without
 * one has to ask.
 */

/**
 * Drop a file ON a table window, through the real path.
 *
 * Dispatched and then left alone: the event bubbles to the shell's own document
 * listener, which is what runs the drop handlers. Running them here as well — as the
 * other import specs do, since they build an event without dispatching it — would
 * start the whole import twice and put two dialogs up in sequence.
 */
async function dropJsonOnPanel(page: import('@playwright/test').Page, tableId: string, body: unknown) {
  await page.evaluate(
    ({ domId, text }) => {
      const dt = new DataTransfer();
      dt.items.add(new File([text], 'multi.db.json', { type: 'application/json' }));
      document.getElementById(domId)!.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
    },
    { domId: panelDomId(tableId), text: JSON.stringify(body) },
  );
}

const multi = {
  workspaceId: 'whatever',
  exportedAt: 1,
  tables: [
    { name: 'pets', columns: [{ field: 'name', label: 'name', type: 'string' }], rows: [{ name: 'cat' }, { name: 'dog' }] },
    { name: 'people', columns: [{ field: 'name', label: 'name', type: 'string' }], rows: [{ name: 'Erin' }, { name: 'Frank' }, { name: 'Gil' }] },
  ],
};

test('a table of the same name is taken without asking', async ({ page }) => {
  const id = await createTable(page, 'people', [{ field: 'name', label: 'name', renderer: 'link' }]);
  await bulkAddRows(page, id, [{ name: 'old' }]);
  await waitForPanel(page, id);

  await dropJsonOnPanel(page, id, multi);

  // Straight to the mode question — no picker, because "people" names itself.
  const dialogs = page.locator('host-dialogs');
  await expect(dialogs.getByText(/Import "multi\.db\.json" into "people"/)).toBeVisible();
  await expect(dialogs.locator('button.choice', { hasText: 'pets' })).toHaveCount(0);
  await dialogs.locator('button.choice', { hasText: /^Re-Load/ }).click();

  await expect.poll(async () => ((await readRows(page, id)) as Array<{ data: { name: string } }>).map((r) => r.data.name).sort()).toEqual(['Erin', 'Frank', 'Gil']);
});

test('with no name match the file offers its tables, and the chosen one lands', async ({ page }) => {
  const id = await createTable(page, 'guests', [{ field: 'name', label: 'name', renderer: 'link' }]);
  await waitForPanel(page, id);

  await dropJsonOnPanel(page, id, multi);

  const dialogs = page.locator('host-dialogs');
  // The picker names the destination and lists the file's tables with their sizes.
  await expect(dialogs.getByText(/Which table from the file/)).toBeVisible();
  await expect(dialogs.locator('button.choice', { hasText: 'pets' })).toBeVisible();
  await dialogs.locator('button.choice', { hasText: 'people' }).click();

  // Then the ordinary mode question, exactly as a single-table file asks it.
  await expect(dialogs.getByText(/Import "multi\.db\.json" into "guests"/)).toBeVisible();
  await dialogs.locator('button.choice', { hasText: /^Re-Load/ }).click();

  await expect.poll(async () => ((await readRows(page, id)) as Array<{ data: { name: string } }>).map((r) => r.data.name).sort()).toEqual(['Erin', 'Frank', 'Gil']);
  // The destination keeps its own identity — this is a load, not a rename.
  expect(((await readTable(page, id)) as { name: string }).name).toBe('guests');
});

test('the chosen table still goes through the column mapper when the fields differ', async ({ page }) => {
  // The picker only decides WHICH table is the source. Everything after it is the
  // path a single-table file already took, mapper included — proved here end to end
  // rather than assumed from the shared function.
  const id = await createTable(page, 'guests', [{ field: 'name', label: 'name', renderer: 'link' }]);
  await waitForPanel(page, id);

  await dropJsonOnPanel(page, id, {
    workspaceId: 'w',
    exportedAt: 1,
    tables: [
      { name: 'pets', columns: [{ field: 'species', label: 'species', type: 'string' }], rows: [{ species: 'cat' }] },
      { name: 'people', columns: [{ field: 'fullname', label: 'fullname', type: 'string' }], rows: [{ fullname: 'Erin' }] },
    ],
  });

  const dialogs = page.locator('host-dialogs');
  await dialogs.locator('button.choice', { hasText: 'people' }).click();
  await dialogs.locator('button.choice', { hasText: /^Append/ }).click();

  // `fullname` is not `name`, so the mapper asks rather than guessing by position.
  const mapper = page.locator('column-map-dialog dialog');
  await expect(mapper).toBeVisible();
  await mapper.locator('select').first().selectOption('name');
  await mapper.getByRole('button', { name: 'Append' }).click();

  await expect.poll(async () => ((await readRows(page, id)) as Array<{ data: { name?: string } }>).map((r) => r.data.name)).toEqual(['Erin']);
});
