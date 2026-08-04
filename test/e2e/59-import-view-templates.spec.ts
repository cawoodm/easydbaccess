import { test, expect } from './fixtures.js';

/**
 * Importing a workspace dump must OVERWRITE a view template the workspace
 * already has, not add a second one beside it.
 *
 * The dump is written by another device, and the `views` plugin seeds every
 * built-in template with a fresh uuid per workspace. So the dump's "Gallery"
 * and the local "Gallery" share a name but never an id — and an upsert by id
 * alone produced two "Gallery" entries in the Views dialog after every import.
 */

/** Inject a synthetic file-drop into the drop handler registry. */
async function dropFile(page: import('@playwright/test').Page, filename: string, text: string) {
  await page.evaluate(
    async ({ filename, text }) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ctx = (window as any).__easydb;
      const file = new File([text], filename, { type: 'application/json' });
      const dt = new DataTransfer();
      dt.items.add(file);
      const event = new DragEvent('drop', { bubbles: true, dataTransfer: dt });
      for (const fn of ctx.registries.dropHandlers) {
        if (await fn(event, ctx.api)) break;
      }
    },
    { filename, text },
  );
}

function templatesNamed(page: import('@playwright/test').Page, ws: string, name: string) {
  return page.evaluate(
    async ({ ws, name }) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const store = (window as any).__easydb.store;
      const all = await store.viewTemplates.find({ workspaceId: ws });
      return (all as Array<{ id: string; name: string; rowHtml: string }>).filter((t) => t.name === name).map((t) => ({ id: t.id, rowHtml: t.rowHtml }));
    },
    { ws, name },
  );
}

test('a dump overwrites the same-named view template instead of duplicating it', async ({ page, workspaceId }) => {
  // The views plugin seeds the built-ins asynchronously on boot.
  await expect.poll(async () => (await templatesNamed(page, workspaceId, 'Gallery')).length).toBe(1);
  const before = await templatesNamed(page, workspaceId, 'Gallery');
  const localId = before[0]!.id;

  const dump = JSON.stringify({
    workspaceId: 'other-device',
    exportedAt: 1,
    tables: [
      {
        name: 'people',
        columns: [
          { field: 'name', label: 'Name', type: 'string' },
          { field: 'pic', label: 'Pic', type: 'string' },
        ],
        rows: [{ name: 'Ada', pic: 'a.png' }],
      },
    ],
    viewTemplates: [
      {
        id: 'foreign-gallery-id',
        workspaceId: 'other-device',
        name: 'Gallery',
        headerHtml: '<div class="g">',
        rowHtml: '<b class="imported">$TITLE</b>',
        footerHtml: '</div>',
        builtin: true,
        updatedAt: 2,
      },
    ],
    viewInstances: [
      {
        id: 'imported-instance',
        workspaceId: 'other-device',
        tableId: 'stale-table-id',
        tableName: 'people',
        templateId: 'foreign-gallery-id',
        name: 'Faces',
        filters: {},
        visibleColumns: ['name', 'pic'],
        mapping: { TITLE: 'name' },
        open: true,
        updatedAt: 2,
      },
    ],
  });

  // One table, no name collision → the import runs without a mode prompt.
  await dropFile(page, 'other.db.json', dump);

  await expect.poll(async () => (await templatesNamed(page, workspaceId, 'Gallery')).length).toBe(1);
  const after = await templatesNamed(page, workspaceId, 'Gallery');
  expect(after[0]!.id).toBe(localId); // kept the LOCAL id
  expect(after[0]!.rowHtml).toContain('imported'); // took the dump's HTML

  // The imported instance was re-pointed at the local template id, so its
  // window finds a template and renders the row HTML.
  const inst = await page.evaluate(async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const store = (window as any).__easydb.store;
    return (await store.viewInstances.findOne('imported-instance')) as {
      templateId: string;
    } | null;
  });
  expect(inst?.templateId).toBe(localId);

  const viewPanel = page.locator('[id^="view-panel-"]');
  await expect(viewPanel).toBeVisible();
  await expect(viewPanel.locator('.imported')).toHaveText('Ada');
});
