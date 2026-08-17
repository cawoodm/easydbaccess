import type { Page } from '@playwright/test';

/**
 * Test helpers that drive the renderer through its real HostApi/DataStore
 * instead of through clicks. Anything that doesn't *need* to be a click flow
 * (set up state, inspect state, navigate) should go through these.
 */

export interface TestColumn {
  field: string;
  label?: string;
  type?: 'string' | 'number' | 'boolean' | 'date' | 'datetime' | 'array';
  /**
   * Cell renderer name. The app stopped auto-picking renderers in v0.0.5
   * — a column without one renders as read-only HTML-encoded text. Tests
   * that want editable cells must pick a renderer explicitly (e.g.
   * `'link'` for plain string editing; `'date'` / `'datetime'` /
   * `'boolean'` for the matching native inputs).
   */
  renderer?: string;
  /**
   * JS body defining `function render(row) {…}`. Valid on ANY column: the return
   * value is what the column's renderer displays (raw HTML for the `script`
   * renderer).
   */
  script?: string;
  /**
   * JS body defining `function validate(value, row) {…}` — throwing rejects a
   * manual cell edit. Only manual edits run it, so helpers that write rows
   * directly (like `bulkAddRows`) are unaffected by it.
   */
  validate?: string;
  /** Column rules the footer's Validate button and the Save pre-flight check. */
  notnull?: boolean;
  unique?: boolean;
  max?: number;
}

/** Creates a table via the data-store. Returns the new table id. */
export async function createTable(page: Page, name: string, columns: TestColumn[]): Promise<string> {
  return page.evaluate(
    async ({ name, columns }) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ctx = (window as any).__easydb;
      const id = crypto.randomUUID();
      await ctx.store.tables.insert({
        id,
        workspaceId: ctx.workspaceId,
        name,
        code: name.toLowerCase().replace(/\s+/g, '-') || 'table',
        columns: columns.map((c) => {
          const col: {
            field: string;
            label: string;
            type: string;
            renderer?: string;
            script?: string;
            validate?: string;
            notnull?: boolean;
            unique?: boolean;
            max?: number;
          } = {
            field: c.field,
            label: c.label ?? c.field,
            type: c.type ?? 'string',
          };
          if (c.renderer) col.renderer = c.renderer;
          if (c.script) col.script = c.script;
          if (c.validate) col.validate = c.validate;
          if (c.notnull) col.notnull = true;
          if (c.unique) col.unique = true;
          if (c.max != null) col.max = c.max;
          return col;
        }),
        view: 'table',
        updatedAt: Date.now(),
      });
      return id;
    },
    { name, columns },
  );
}

/** Bulk-inserts rows into a table. Returns the inserted row ids. */
export async function bulkAddRows(page: Page, tableId: string, rows: Array<Record<string, unknown>>): Promise<string[]> {
  return page.evaluate(
    async ({ tableId, rows }) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ctx = (window as any).__easydb;
      const docs = rows.map((data) => ({
        id: crypto.randomUUID(),
        tableId,
        data,
        updatedAt: Date.now(),
      }));
      await ctx.store.rows(tableId).bulkInsert(docs);
      return docs.map((d) => d.id);
    },
    { tableId, rows },
  );
}

/** Inserts a row into the given table. Returns the new row id. */
export async function addRow(page: Page, tableId: string, data: Record<string, unknown>): Promise<string> {
  return page.evaluate(
    async ({ tableId, data }) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ctx = (window as any).__easydb;
      const id = crypto.randomUUID();
      await ctx.store.rows(tableId).insert({
        id,
        tableId,
        data,
        updatedAt: Date.now(),
      });
      return id;
    },
    { tableId, data },
  );
}

/** Reads a table record (post-mutation assertions). */
export async function readTable(page: Page, tableId: string) {
  return page.evaluate(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async (id) => (window as any).__easydb.store.tables.findOne(id),
    tableId,
  );
}

/** Reads all rows for a table. */
export async function readRows(page: Page, tableId: string) {
  return page.evaluate(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async (id) => (window as any).__easydb.store.rows(id).find(),
    tableId,
  );
}

/**
 * Reads a view-instance record — the counterpart of `readTable` for view
 * windows, whose geometry (and front rank) lives on `viewInstances`, not on the
 * table. Specs that front a view need this: the write is asynchronous, so the
 * only way to know it landed is to read it back.
 */
export async function readViewInstance(page: Page, instanceId: string) {
  return page.evaluate(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async (id) => (window as any).__easydb.store.viewInstances.findOne(id),
    instanceId,
  );
}

/**
 * Answer the storage-strategy question "New workspace" asks between the name
 * prompt and the "what does it start with?" choice.
 *
 * Simple keeps the workspace in IndexedDB, which is what every workspace did
 * before `.edb` files existed and what these specs assume. The click is
 * unconditional on purpose: the question always appears in Chromium, so a silent
 * skip would hide the question disappearing.
 */
export async function chooseSimpleStorage(page: Page): Promise<void> {
  await page
    .locator('host-dialogs')
    .getByRole('button', { name: /^Simple/ })
    .click();
}

/**
 * Waits until the built-in view templates have finished seeding.
 *
 * `plugins/views.ts`'s `seedDefaults` walks its four built-ins one at a time,
 * and each one is several store round trips. Opening the Views dialog before it
 * finishes shows a list that is short and then never grows — the dialog reads
 * the templates once, when it opens. Under Dexie the seeding was over before a
 * test could get there.
 */
export async function waitForViewTemplates(page: Page, count = 4) {
  await page.waitForFunction(
    async (n) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ctx = (window as any).__easydb;
      if (!ctx) return false;
      const all = (await ctx.store.viewTemplates.find({ workspaceId: ctx.workspaceId })) as Array<{ builtin?: boolean }>;
      return all.filter((t) => t.builtin).length >= n;
    },
    count,
    { timeout: 20_000 },
  );
}

/** Returns the jsPanel DOM id derived from a table id (mirrors cssSafe()). */
export function panelDomId(tableId: string): string {
  return `panel-${tableId.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
}

/** Returns the panel DOM id of a view window (mirrors view-window-manager's). */
export function viewPanelDomId(instanceId: string): string {
  return `view-panel-${instanceId.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
}

/** The view-instance id behind a view panel's DOM id — the inverse of
 *  `viewPanelDomId`, exact because instance ids are UUIDs. */
export function viewInstanceIdOf(panelId: string): string {
  return panelId.replace(/^view-panel-/, '');
}

/**
 * Waits until the panel for a given table is mounted AND its grid has settled.
 *
 * `state: 'attached'`, not Playwright's default `'visible'`: a panel that
 * boots (or is driven) minimized is `display:none` in the shell — a
 * deliberate change from jsPanel's old off-screen `left:-9999` parking (see
 * panel-shell.ts) — so it would never satisfy a visibility wait.
 *
 * The settle half is the part that matters now. A panel attaches BEFORE its
 * `<data-table>` has bound to the store and read its first rows, and every read
 * is a round trip to the SQLite worker. Anything a test does in that gap races
 * the grid's own first pass: a click lands on a cell the next render replaces,
 * so the event's `composedPath()` runs out in a detached subtree and whatever
 * reads the click's context (`commandlets`' `$TABLE`, for one) finds nothing;
 * a drag reads a column width that a re-render then overwrites; a
 * `locator.all()` snapshots a `<tbody>` that has not been filled in yet. Under
 * Dexie the first read resolved fast enough that the gap rarely opened.
 *
 * Settled means bound, and then unchanged — same row count, same load
 * generation — for a beat. A minimized panel mounts no grid at all, which
 * counts as settled: there is nothing to wait for.
 */
export async function waitForPanel(page: Page, tableId: string) {
  const domId = panelDomId(tableId);
  await page.locator(`#${domId}`).waitFor({ state: 'attached' });
  await page.waitForFunction(
    (pid) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const dt = document.querySelector(`#${pid} data-table`) as any;
      if (!dt) return true;
      if (!dt.boundKey) return false;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const w = window as any;
      const seen: Record<string, { key: string; at: number }> = (w.__gridSettle ??= {});
      const key = `${dt.rows?.length ?? -1}|${dt.loadGeneration ?? -1}|${dt.loading ? 1 : 0}`;
      const prev = seen[pid];
      if (!prev || prev.key !== key) {
        seen[pid] = { key, at: performance.now() };
        return false;
      }
      return performance.now() - prev.at > 150;
    },
    domId,
    { timeout: 20_000 },
  );
}
