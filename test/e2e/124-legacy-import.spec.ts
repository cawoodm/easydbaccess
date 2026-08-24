import { test, expect } from './fixtures.js';
import type { Page } from '@playwright/test';

/**
 * Bringing pre-SQLite browser data across.
 *
 * Until v0.0.383 the browser store was Dexie over an IndexedDB database named
 * `easydb`. This seeds a real one — same stores, same indexes, same document
 * shapes — and drives the offer the app makes on the next boot. A phone has no
 * File System Access API, so this path is the only way to that data; if it
 * breaks, the data is gone for the users it exists for.
 */

interface LegacySeed {
  workspaces: Array<{ id: string; name: string; createdAt?: number; pluginUrls?: string[]; title?: string }>;
  tables: Array<Record<string, unknown>>;
  rows: Array<Record<string, unknown>>;
  settings?: Array<Record<string, unknown>>;
  viewTemplates?: Array<Record<string, unknown>>;
  viewInstances?: Array<Record<string, unknown>>;
}

/** Build the legacy database exactly as Dexie left it at schema v3. */
async function seedLegacy(page: Page, seed: LegacySeed): Promise<void> {
  await page.evaluate(async (data: LegacySeed) => {
    await new Promise<void>((resolve, reject) => {
      const req = indexedDB.open('easydb', 3);
      req.onupgradeneeded = () => {
        const db = req.result;
        db.createObjectStore('workspaces', { keyPath: 'id' });
        const tables = db.createObjectStore('tables', { keyPath: 'id' });
        tables.createIndex('workspaceId', 'workspaceId');
        tables.createIndex('updatedAt', 'updatedAt');
        const rows = db.createObjectStore('rows', { keyPath: 'id' });
        rows.createIndex('tableId', 'tableId');
        rows.createIndex('updatedAt', 'updatedAt');
        const settings = db.createObjectStore('settings', { keyPath: 'key' });
        settings.createIndex('workspaceId', 'workspaceId');
        settings.createIndex('name', 'name');
        db.createObjectStore('plugins', { keyPath: 'url' });
        const vt = db.createObjectStore('viewTemplates', { keyPath: 'id' });
        vt.createIndex('workspaceId', 'workspaceId');
        const vi = db.createObjectStore('viewInstances', { keyPath: 'id' });
        vi.createIndex('workspaceId', 'workspaceId');
        vi.createIndex('tableId', 'tableId');
      };
      req.onsuccess = () => {
        const db = req.result;
        const tx = db.transaction(['workspaces', 'tables', 'rows', 'settings', 'viewTemplates', 'viewInstances'], 'readwrite');
        for (const w of data.workspaces) tx.objectStore('workspaces').put({ createdAt: 0, pluginUrls: [], ...w });
        for (const t of data.tables) tx.objectStore('tables').put(t);
        for (const r of data.rows) tx.objectStore('rows').put(r);
        for (const s of data.settings ?? []) tx.objectStore('settings').put(s);
        for (const v of data.viewTemplates ?? []) tx.objectStore('viewTemplates').put(v);
        for (const v of data.viewInstances ?? []) tx.objectStore('viewInstances').put(v);
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
        tx.onerror = () => reject(tx.error);
      };
      req.onerror = () => reject(req.error);
    });
  }, seed);
}

/** A table doc as the old store held it. */
function legacyTable(id: string, workspaceId: string, name: string) {
  return {
    id,
    workspaceId,
    name,
    code: name.toLowerCase(),
    columns: [
      { field: 'name', label: 'Name', type: 'string', renderer: 'link' },
      { field: 'note', label: 'Note', type: 'string' },
    ],
    view: 'table',
    updatedAt: 1,
  };
}

/** Boot the app again, so the plugin's `load()` sees what was just seeded. */
async function reboot(page: Page, workspaceId: string): Promise<void> {
  await page.goto(`/?test=1&space=${encodeURIComponent(workspaceId)}`);
  await page.waitForFunction(() => Boolean((window as unknown as { __easydb?: unknown }).__easydb), { timeout: 15_000 });
}

const dialog = (page: Page) => page.locator('host-dialogs');
const choice = (page: Page, label: string) => dialog(page).locator('button.choice', { hasText: label });

/** Read back what actually landed in the SQLite store. */
async function readWorkspace(page: Page, workspaceId: string) {
  return page.evaluate(async (id: string) => {
    const ctx = (window as unknown as { __easydb: { store: Record<string, never> } }).__easydb as unknown as {
      store: {
        workspaces: { find(): Promise<Array<{ id: string; name: string; title?: string }>> };
        tables: { find(q: { workspaceId: string }): Promise<Array<{ id: string; name: string }>> };
        rows(tableId: string): { find(): Promise<Array<{ id: string; data: Record<string, unknown> }>> };
        viewInstances: { find(q: { workspaceId: string }): Promise<Array<{ id: string; tableId: string; templateId: string }>> };
        viewTemplates: { find(q: { workspaceId: string }): Promise<Array<{ id: string }>> };
      };
    };
    const workspaces = await ctx.store.workspaces.find();
    const tables = await ctx.store.tables.find({ workspaceId: id });
    const out: Record<string, Array<Record<string, unknown>>> = {};
    for (const t of tables) out[t.name] = (await ctx.store.rows(t.id).find()).map((r) => r.data);
    return {
      exists: workspaces.some((w) => w.id === id),
      tableNames: tables.map((t) => t.name).sort(),
      tableIds: tables.map((t) => t.id).sort(),
      rowsByTable: out,
      views: await ctx.store.viewInstances.find({ workspaceId: id }),
      templates: await ctx.store.viewTemplates.find({ workspaceId: id }),
    };
  }, workspaceId);
}

/**
 * `readWorkspace`, but tolerating a page that is mid-reload.
 *
 * A replace ends in `reloadWithSpace`, so an evaluate can land in an execution
 * context that is being torn down. That is not a failure to assert on — it is
 * the reload the test is waiting for — so it polls as "not yet".
 */
async function readWorkspaceWhenSettled(page: Page, workspaceId: string) {
  try {
    return await readWorkspace(page, workspaceId);
  } catch {
    return null;
  }
}

/** Is the old database still there? Nothing must delete it behind the user's back. */
function legacyStillThere(page: Page): Promise<boolean> {
  return page.evaluate(async () => {
    const dbs = (await indexedDB.databases?.()) ?? [];
    return dbs.some((d) => d.name === 'easydb');
  });
}

test('the offer copies a stranded workspace in, with its rows and its view', async ({ page, workspaceId }) => {
  await seedLegacy(page, {
    workspaces: [{ id: 'legacy-demo', name: 'legacy-demo', title: 'My Old Data' }],
    tables: [legacyTable('t-people', 'legacy-demo', 'People'), legacyTable('t-pets', 'legacy-demo', 'Pets')],
    rows: [
      { id: 'r1', tableId: 't-people', data: { name: 'Ada', note: 'first' }, updatedAt: 1 },
      { id: 'r2', tableId: 't-people', data: { name: 'Grace', note: 'second' }, updatedAt: 1 },
      { id: 'r3', tableId: 't-pets', data: { name: 'Rex', note: '' }, updatedAt: 1 },
    ],
    viewTemplates: [{ id: 'tpl-1', workspaceId: 'legacy-demo', name: 'Cards', headerHtml: '', rowHtml: '<b>$NAME</b>', footerHtml: '', updatedAt: 1 }],
    viewInstances: [
      {
        id: 'vi-1',
        workspaceId: 'legacy-demo',
        tableId: 't-people',
        templateId: 'tpl-1',
        name: 'People cards',
        filters: {},
        visibleColumns: ['name'],
        mapping: { NAME: 'name' },
        open: false,
        updatedAt: 1,
      },
    ],
  });
  await reboot(page, workspaceId);

  // The offer says what it found before anything is written.
  await expect(dialog(page).locator('h2', { hasText: 'Data from an older version' })).toBeVisible();
  await expect(dialog(page)).toContainText('1 workspace, 2 tables, 3 rows');
  await choice(page, 'Bring it across').click();

  await expect.poll(async () => (await readWorkspace(page, 'legacy-demo')).exists, { timeout: 20_000 }).toBe(true);

  const landed = await readWorkspace(page, 'legacy-demo');
  expect(landed.tableNames).toEqual(['People', 'Pets']);
  expect(landed.rowsByTable['People']).toEqual([
    { name: 'Ada', note: 'first' },
    { name: 'Grace', note: 'second' },
  ]);
  expect(landed.rowsByTable['Pets']).toEqual([{ name: 'Rex', note: '' }]);
  // A view came too, still bound to its table and its template.
  expect(landed.views).toHaveLength(1);
  expect(landed.views[0]!.tableId).toBe('t-people');
  expect(landed.templates.map((t) => t.id)).toEqual(['tpl-1']);

  // The copy is additive: the old database is untouched, which is the promise
  // the offer makes.
  expect(await legacyStillThere(page)).toBe(true);
});

test('declining writes nothing, and does not ask again on the next boot', async ({ page, workspaceId }) => {
  await seedLegacy(page, {
    workspaces: [{ id: 'legacy-demo', name: 'legacy-demo' }],
    tables: [legacyTable('t-people', 'legacy-demo', 'People')],
    rows: [{ id: 'r1', tableId: 't-people', data: { name: 'Ada' }, updatedAt: 1 }],
  });
  await reboot(page, workspaceId);

  await choice(page, 'Not now').click();
  expect((await readWorkspace(page, 'legacy-demo')).exists).toBe(false);

  // Asked once. A boot that re-asks is a boot the user cannot get past.
  await reboot(page, workspaceId);
  await expect(dialog(page).locator('h2', { hasText: 'Data from an older version' })).toBeHidden();
  expect(await legacyStillThere(page)).toBe(true);
});

test('a name already taken can keep both copies, and the second gets its own table ids', async ({ page, workspaceId }) => {
  // The legacy workspace carries the id this test is already using, so the copy
  // cannot land under it.
  await seedLegacy(page, {
    workspaces: [{ id: workspaceId, name: workspaceId }],
    tables: [legacyTable('t-people', workspaceId, 'People')],
    rows: [{ id: 'r1', tableId: 't-people', data: { name: 'Ada' }, updatedAt: 1 }],
  });
  await reboot(page, workspaceId);

  await choice(page, 'Bring it across').click();
  await expect(choice(page, 'Keep both, under a new name')).toBeVisible();
  await choice(page, 'Keep both, under a new name').click();

  const renamed = `${workspaceId}-2`;
  await expect.poll(async () => (await readWorkspace(page, renamed)).exists, { timeout: 20_000 }).toBe(true);

  const copy = await readWorkspace(page, renamed);
  expect(copy.tableNames).toEqual(['People']);
  expect(copy.rowsByTable['People']).toEqual([{ name: 'Ada' }]);
  // `tables` is one collection keyed by table id across every workspace, so the
  // copy must NOT have brought `t-people` with it.
  expect(copy.tableIds).not.toContain('t-people');
});

test('replacing a workspace leaves only what came across', async ({ page, workspaceId }) => {
  // Something of the user's own, under the id the legacy copy also claims.
  await page.evaluate(async () => {
    const ctx = (window as unknown as { __easydb: { workspaceId: string; store: { tables: { insert(d: unknown): Promise<unknown> } } } }).__easydb;
    await ctx.store.tables.insert({
      id: 'mine',
      workspaceId: ctx.workspaceId,
      name: 'Mine',
      code: 'mine',
      columns: [{ field: 'name', label: 'Name', type: 'string' }],
      view: 'table',
      updatedAt: 1,
    });
  });

  await seedLegacy(page, {
    workspaces: [{ id: workspaceId, name: workspaceId }],
    tables: [legacyTable('t-people', workspaceId, 'People')],
    rows: [{ id: 'r1', tableId: 't-people', data: { name: 'Ada' }, updatedAt: 1 }],
  });
  await reboot(page, workspaceId);

  await choice(page, 'Bring it across').click();
  await choice(page, 'Replace the one here').click();

  // The replace ends in a reload, because the workspace on screen is the one
  // whose contents just went. "Mine" going is the point: a copy is additive, so
  // without the delete both sets of tables would sit in one workspace.
  await expect.poll(async () => (await readWorkspaceWhenSettled(page, workspaceId))?.tableNames, { timeout: 30_000 }).toEqual(['People']);
});

test('the old copy can be removed once, deliberately', async ({ page, workspaceId }) => {
  await seedLegacy(page, {
    workspaces: [{ id: 'legacy-demo', name: 'legacy-demo' }],
    tables: [legacyTable('t-people', 'legacy-demo', 'People')],
    rows: [{ id: 'r1', tableId: 't-people', data: { name: 'Ada' }, updatedAt: 1 }],
  });
  await reboot(page, workspaceId);
  await choice(page, 'Not now').click();

  await page
    .locator('app-shell header')
    .getByTitle(/open the command palette/i)
    .click();
  const palette = page.locator('command-palette-dialog dialog');
  await expect(palette).toBeVisible();
  await palette.locator('input').fill('Remove data from older versions');
  await palette
    .locator('.item')
    .filter({ has: page.getByText('Remove data from older versions', { exact: true }) })
    .first()
    .click();

  await expect(dialog(page).locator('h2', { hasText: 'Remove data from older versions' })).toBeVisible();
  await choice(page, 'Yes').click();

  await expect.poll(async () => legacyStillThere(page), { timeout: 20_000 }).toBe(false);
});
