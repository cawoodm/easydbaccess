import type { Page } from '@playwright/test';

/**
 * Test helpers that drive the renderer through its real HostApi/DataStore
 * instead of through clicks. Anything that doesn't *need* to be a click flow
 * (set up state, inspect state, navigate) should go through these.
 */

export interface TestColumn {
  field: string;
  label?: string;
  type?: 'string' | 'number' | 'boolean' | 'date' | 'datetime';
  /**
   * Cell renderer name. The app stopped auto-picking renderers in v0.0.5
   * — a column without one renders as read-only HTML-encoded text. Tests
   * that want editable cells must pick a renderer explicitly (e.g.
   * `'link'` for plain string editing; `'date'` / `'datetime'` /
   * `'boolean'` for the matching native inputs).
   */
  renderer?: string;
}

/** Creates a table via the data-store. Returns the new table id. */
export async function createTable(
  page: Page,
  name: string,
  columns: TestColumn[],
): Promise<string> {
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
          } = {
            field: c.field,
            label: c.label ?? c.field,
            type: c.type ?? 'string',
          };
          if (c.renderer) col.renderer = c.renderer;
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
export async function bulkAddRows(
  page: Page,
  tableId: string,
  rows: Array<Record<string, unknown>>,
): Promise<string[]> {
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
export async function addRow(
  page: Page,
  tableId: string,
  data: Record<string, unknown>,
): Promise<string> {
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

/** Returns the jsPanel DOM id derived from a table id (mirrors cssSafe()). */
export function panelDomId(tableId: string): string {
  return `panel-${tableId.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
}

/** Waits until the panel for a given table is mounted in the DOM. */
export async function waitForPanel(page: Page, tableId: string) {
  await page.locator(`#${panelDomId(tableId)}`).waitFor();
}
