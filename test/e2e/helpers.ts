import { expect, type Page } from '@playwright/test';

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

/**
 * Lift the browser store's 10,000-row limit for this page.
 *
 * For fixtures only — a spec that has to seed a table bigger than a user is
 * allowed to make, to prove something about the grid's own 20,000-row read cap.
 * Call it BEFORE the seeding write. Nothing in the app sets this: see
 * `db/row-budget.ts`.
 */
export async function liftRowLimit(page: Page, to = 1_000_000): Promise<void> {
  await page.evaluate((n) => {
    (window as unknown as { __easydbRowLimit?: number }).__easydbRowLimit = n;
  }, to);
}

/** The key `db/edb/registry.ts` keeps: workspace id → the `.edb` it lives in. */
export const EDB_REGISTRY_KEY = 'easydb:edb:workspaces';

/** The registry write both binders share, as a page function argument. */
const WRITE_BINDING = ({ key, id, file, name }: { key: string; id: string; file: string; name: string }) => {
  const raw = localStorage.getItem(key);
  const map: Record<string, { name: string; file: string }> = raw ? JSON.parse(raw) : {};
  map[id] = { name, file };
  localStorage.setItem(key, JSON.stringify(map));
};

/**
 * Say that `workspaceId` lives in `file`, before the app's first line runs.
 *
 * The OS file picker cannot be driven from Playwright, so this writes what the
 * picker would have written. An init script, not an `evaluate`: the entry has to
 * be in place before the FIRST navigation, when there is no page to write from.
 * Merged rather than overwritten, so a spec can bind two workspaces to two files.
 *
 * It runs again on every later navigation, which is why deleting a workspace
 * needs {@link bindWorkspaceToFileOnce} instead — an init script would put the
 * entry straight back.
 */
export async function bindWorkspaceToFile(page: Page, workspaceId: string, file: string, name = workspaceId): Promise<void> {
  await page.addInitScript(WRITE_BINDING, { key: EDB_REGISTRY_KEY, id: workspaceId, file, name });
}

/**
 * The same binding, written once into a page that is already loaded.
 *
 * For a spec that then expects the entry to CHANGE — a delete, a Save As. The
 * next boot reads it, so the effect on that boot is identical.
 */
export async function bindWorkspaceToFileOnce(page: Page, workspaceId: string, file: string, name = workspaceId): Promise<void> {
  await page.evaluate(WRITE_BINDING, { key: EDB_REGISTRY_KEY, id: workspaceId, file, name });
}

/** Mirrors `db/edb/mirror.ts` — one file per workspace, under its own directory. */
function edbMirrorPath(edbName: string): string {
  return `edb-mirror/${encodeURIComponent(edbName)}.edb`;
}

/** The mirrored bytes, base64 — the only shape that survives `page.evaluate`. */
async function edbMirrorBase64(page: Page, edbName: string): Promise<string | null> {
  return page.evaluate(async (path) => {
    const [dir, file] = path.split('/');
    try {
      const root = await navigator.storage.getDirectory();
      const handle = await (await root.getDirectoryHandle(dir!)).getFileHandle(file!);
      const bytes = new Uint8Array(await (await handle.getFile()).arrayBuffer());
      if (bytes.byteLength === 0) return null;
      let binary = '';
      // Chunked: spreading 100k+ bytes into `fromCharCode` blows the argument limit.
      for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
      return btoa(binary);
    } catch {
      return null; // not written yet — the caller polls
    }
  }, edbMirrorPath(edbName));
}

/**
 * Wait out the mirror's 2s debounce and hand back its bytes.
 *
 * Call this before navigating away from a file-backed workspace. Boot restores
 * from the mirror, so leaving before it is written comes back to an empty
 * database — and the test then blames the app for losing the data.
 */
export async function waitForEdbMirror(page: Page, edbName: string): Promise<Buffer> {
  let b64: string | null = null;
  await expect.poll(async () => (b64 = await edbMirrorBase64(page, edbName)) !== null, { timeout: 20_000, message: 'the OPFS mirror was never written' }).toBe(true);
  return Buffer.from(b64!, 'base64');
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
 * Waits until the panel for a given table is mounted in the DOM.
 *
 * `state: 'attached'`, not Playwright's default `'visible'`: a panel that
 * boots (or is driven) minimized is `display:none` in the shell — a
 * deliberate change from jsPanel's old off-screen `left:-9999` parking (see
 * panel-shell.ts) — so it would never satisfy a visibility wait.
 */
export async function waitForPanel(page: Page, tableId: string) {
  await page.locator(`#${panelDomId(tableId)}`).waitFor({ state: 'attached' });
}
