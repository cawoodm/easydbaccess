import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test';

/**
 * Launching the real desktop app, and reading the file it writes.
 *
 * The browser suite talks to a Vite dev server. This one starts Electron itself
 * — main process, preload, `file://` renderer and all — because the thing under
 * test is the desktop STORAGE: `packages/electron/src/sqlite-store.ts` bound to
 * `EdbStore` over `node:sqlite`. Nothing about that is reachable from a browser
 * page, and the vitest suites in `test/electron/` drive the store class directly
 * without the app around it.
 *
 * Two kinds of assertion follow from that. Through the page, the app behaves as
 * a user's would. Through {@link readEdb}, the FILE is a plain SQLite database
 * this test process can open with no help from the app — which is the whole
 * claim the `.edb` format makes.
 */

/** Repo root. Playwright runs from there, the same assumption `playwright.config.ts` makes. */
const ROOT = process.cwd();
const MAIN_JS = resolve(ROOT, 'packages/electron/dist/main.js');
const FRONTEND = resolve(ROOT, 'packages/electron/frontend/index.html');

export interface Desktop {
  app: ElectronApplication;
  /** The renderer, booted, with `window.__easydb` live. */
  page: Page;
  /** The workspace file this instance opened. */
  dbPath: string;
  /** The temp directory holding the workspace file and the isolated `userData`. */
  dir: string;
}

/**
 * A fresh temp directory per test.
 *
 * Pass the same one to a second {@link launchDesktop} to model a restart: the
 * workspace file and the remembered-path state both live here.
 */
export function desktopDir(): string {
  return mkdtempSync(join(tmpdir(), 'easydb-desktop-'));
}

/**
 * Starts the desktop app on a workspace file inside `dir`.
 *
 * Two arguments do the isolating, and both are load-bearing:
 *
 * - `--user-data-dir` moves `app.getPath('userData')` into the temp directory.
 *   Without it the app would open the developer's own `easydbaccess.db` and
 *   rewrite their `db-location.json` — a test suite must not touch either.
 * - The `.edb` path is read by `workspaceFromArgv` (`db-files.ts`), which beats
 *   both the remembered path and the auto-load setting. It is how a test names
 *   the file it is about to inspect. The file has to EXIST for that check to
 *   accept it, so an empty one is created first — zero bytes is a valid empty
 *   SQLite database, and `EdbStore`'s constructor creates the schema in it.
 */
export async function launchDesktop(dir: string, name = 'workspace.edb'): Promise<Desktop> {
  if (!existsSync(MAIN_JS)) throw new Error(`main process not built: ${MAIN_JS}\nRun: npm run build --workspace @easydb/electron`);
  if (!existsSync(FRONTEND)) throw new Error(`renderer not built: ${FRONTEND}\nRun: npm run build:electron --workspace @easydb/renderer`);

  const userData = join(dir, 'userData');
  mkdirSync(userData, { recursive: true });
  const dbPath = join(dir, name);
  if (!existsSync(dbPath)) writeFileSync(dbPath, '');

  const app = await electron.launch({
    args: [`--user-data-dir=${userData}`, MAIN_JS, dbPath],
    // EASYDB_E2E makes main.ts load the renderer with `?test=1`, which is what
    // publishes the live AppContext on `window.__easydb`.
    env: { ...process.env, EASYDB_E2E: '1' },
  });
  const page = await app.firstWindow();
  await page.waitForFunction(() => Boolean((window as unknown as { __easydb?: unknown }).__easydb), { timeout: 30_000 });
  return { app, page, dbPath, dir };
}

/** Closes the app. Safe to call twice, so a test can close early and still have its `afterEach`. */
export async function closeDesktop(desktop: Desktop | null): Promise<void> {
  if (!desktop) return;
  try {
    await desktop.app.close();
  } catch {
    /* already gone */
  }
}

/**
 * Replaces the native Save dialog with a fixed answer.
 *
 * Playwright drives a Chromium page, not the OS, so an `electron.dialog` call
 * blocks forever from a test's point of view — nothing can click it. Overwriting
 * the method in the main process is the only way to reach Save As and Convert at
 * all, and it leaves the code under test untouched: `saveDbAs` still runs its
 * checkpoint, close, copy and switch exactly as it does for a real user.
 *
 * `null` answers "cancelled", which is the other branch worth testing.
 */
export async function stubSaveDialog(desktop: Desktop, filePath: string | null): Promise<void> {
  await desktop.app.evaluate(({ dialog }, chosen) => {
    dialog.showSaveDialog = () => Promise.resolve(chosen === null ? { canceled: true, filePath: '' } : { canceled: false, filePath: chosen });
  }, filePath);
}

/** The same, for the Open / Import picker. */
export async function stubOpenDialog(desktop: Desktop, filePath: string | null): Promise<void> {
  await desktop.app.evaluate(({ dialog }, chosen) => {
    dialog.showOpenDialog = () => Promise.resolve(chosen === null ? { canceled: true, filePaths: [] } : { canceled: false, filePaths: [chosen] });
  }, filePath);
}

export interface EdbFile {
  /** Every user object in the file, `sqlite_master` order. */
  objects: Array<{ name: string; type: string }>;
  /** The `_easydb` docs for one collection, newest-first is not guaranteed. */
  docs(coll: string): Array<Record<string, unknown>>;
  /** Every row of a physical SQL table, as SQL returns it. */
  rows(sqlTable: string): Array<Record<string, unknown>>;
  /** Column names of a physical SQL table, DDL order. */
  columns(sqlTable: string): string[];
  close(): void;
}

/**
 * Opens a workspace file with a plain `node:sqlite` connection.
 *
 * Deliberately no app code: if these assertions needed `EdbStore` to make sense
 * of the file, the file would not be the portable database the format promises.
 * Call it after the app has closed, so nothing is racing the read.
 *
 * Not `readOnly`, even though nothing here writes. The store runs in WAL mode,
 * and opening a database read-only while a `-wal` is still beside it fails
 * outright — SQLite needs write access to recover one. A clean exit checkpoints
 * and removes it, so read-only usually works; read-write means a less clean exit
 * produces a real assertion failure instead of a confusing "unable to open".
 */
export function readEdb(dbPath: string): EdbFile {
  const db = new DatabaseSync(dbPath);
  return {
    objects: db.prepare(`SELECT name, type FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name`).all() as Array<{ name: string; type: string }>,
    docs(coll) {
      const rows = db.prepare(`SELECT doc FROM _easydb WHERE coll = ?`).all(coll) as Array<{ doc: string }>;
      return rows.map((r) => JSON.parse(r.doc) as Record<string, unknown>);
    },
    rows(sqlTable) {
      return db.prepare(`SELECT * FROM "${sqlTable}"`).all() as Array<Record<string, unknown>>;
    },
    columns(sqlTable) {
      const info = db.prepare(`SELECT name FROM pragma_table_info(?)`).all(sqlTable) as Array<{ name: string }>;
      return info.map((c) => c.name);
    },
    close: () => db.close(),
  };
}

/**
 * Writes a plain SQLite database — not one of ours — for the Import and Convert
 * paths to consume. Those are the two operations that take a stranger's file,
 * so a test fixture for them must be exactly that.
 */
export function writeForeignDb(path: string, table: string, rows: Array<Record<string, string | number>>): void {
  const db = new DatabaseSync(path);
  const first = rows[0];
  if (!first) throw new Error('writeForeignDb needs at least one row to infer columns');
  const cols = Object.keys(first);
  db.exec(`CREATE TABLE "${table}" (${cols.map((c) => `"${c}" ${typeof first[c] === 'number' ? 'INTEGER' : 'TEXT'}`).join(', ')})`);
  const insert = db.prepare(`INSERT INTO "${table}" (${cols.map((c) => `"${c}"`).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`);
  for (const row of rows) insert.run(...cols.map((c) => row[c] ?? null));
  db.close();
}
