import { test, expect } from './fixtures.js';
import { addRow, createTable } from './helpers.js';
import { SERVER_URL } from './server-url.js';

/**
 * TODO § Architectural follow-ups — auto-sync
 *
 * Verifies the background sync plugin against a real Hono backend launched
 * via playwright.config.ts webServer. Each test gets its own workspace id
 * (via the fixture) so the server's per-workspace blob doesn't bleed
 * between cases.
 *
 * Tick is driven via window.__autoSyncTick — exposed in main.ts when the
 * URL has ?test=1 — so we don't sit waiting on the 60s interval.
 */

/** Configure the renderer's server URL setting (shared with server-sync). */
async function configureServerUrl(page: import('@playwright/test').Page) {
  await page.evaluate(async (url) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ctx = (window as any).__easydb;
    await ctx.store.settings.upsert({ name: 'server-sync:url', value: url });
  }, SERVER_URL);
}

/** Fires one auto-sync tick and waits for the resulting fetch chain to settle. */
async function fireTick(page: import('@playwright/test').Page) {
  await page.evaluate(async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (window as any).__autoSyncTick();
  });
}

async function readServerEtag(wsId: string): Promise<string | null> {
  const res = await fetch(`${SERVER_URL}/sync/${encodeURIComponent(wsId)}`);
  if (!res.ok) return null;
  const e = res.headers.get('ETag');
  if (!e) return null;
  return e.replace(/^"|"$/g, '');
}

test.describe('auto-sync', () => {
  test('seeds an empty workspace via PUT when the server has nothing', async ({ page, workspaceId }) => {
    await configureServerUrl(page);
    await createTable(page, 'Seed', [{ field: 'a' }]);
    await addRow(page, '', {}); // no-op; just exercises __easydb readiness

    // Server has no record of this workspace yet.
    const before = await fetch(`${SERVER_URL}/sync/${encodeURIComponent(workspaceId)}`);
    expect(before.status).toBe(404);

    await fireTick(page);

    // Tick saw 404 and seeded the server. ETag is now stored locally and
    // the server can serve the workspace.
    const after = await fetch(`${SERVER_URL}/sync/${encodeURIComponent(workspaceId)}`);
    expect(after.status).toBe(200);
    const body = (await after.json()) as { tables: Array<{ name: string }> };
    expect(body.tables.map((t) => t.name)).toContain('Seed');
  });

  test('silently pushes local changes on the next tick', async ({ page, workspaceId }) => {
    await configureServerUrl(page);
    await createTable(page, 'Pushable', [{ field: 'n', type: 'number' }]);
    await fireTick(page); // seed
    const seedEtag = await readServerEtag(workspaceId);
    expect(seedEtag).not.toBeNull();

    // Mutate locally — add a row.
    const tableId = await page.evaluate(async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ctx = (window as any).__easydb;
      const tables = await ctx.store.tables.find();
      return tables[0]?.id as string;
    });
    await addRow(page, tableId, { n: 42 });

    // Re-tick — should silently PUT (no dialog).
    await fireTick(page);
    await expect(page.locator('host-dialogs dialog')).toBeHidden();

    // Server now reflects the new row and exposes a new ETag.
    const newEtag = await readServerEtag(workspaceId);
    expect(newEtag).not.toBeNull();
    expect(newEtag).not.toBe(seedEtag);

    const res = await fetch(`${SERVER_URL}/sync/${encodeURIComponent(workspaceId)}`);
    const dump = (await res.json()) as { tables: Array<{ rows: Array<{ n: number }> }> };
    expect(dump.tables[0]?.rows[0]?.n).toBe(42);
  });

  test('prompts to pull when the server has new data; Yes replaces local', async ({ page, workspaceId }) => {
    await configureServerUrl(page);
    await createTable(page, 'Local', [{ field: 'a' }]);
    await fireTick(page); // seed: server now has the "Local" table

    // Out-of-band server change: another client pushes a different shape.
    // No If-Match → server accepts unconditionally.
    const newServerBody = {
      workspaceId,
      exportedAt: Date.now(),
      tables: [
        {
          name: 'FromServer',
          columns: [{ field: 'x', label: 'X', type: 'string' }],
          rows: [{ x: 'hello' }, { x: 'world' }],
        },
      ],
    };
    const pushRes = await fetch(`${SERVER_URL}/sync/${encodeURIComponent(workspaceId)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(newServerBody),
    });
    expect(pushRes.status).toBe(200);

    // Tick should detect divergence and prompt.
    const tickPromise = fireTick(page);
    const dialog = page.locator('host-dialogs');
    await expect(dialog.getByText(/server has new data/i)).toBeVisible();
    await dialog.getByRole('button', { name: 'Yes', exact: true }).click();
    await tickPromise;

    // Local workspace now mirrors the server.
    const tables = await page.evaluate(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      () => (window as any).__easydb.store.tables.find(),
    );
    const names = (tables as Array<{ name: string }>).map((t) => t.name);
    expect(names).toContain('FromServer');
    expect(names).not.toContain('Local');
  });

  test('No on the prompt suppresses re-prompts until the server changes again', async ({ page, workspaceId }) => {
    await configureServerUrl(page);
    await createTable(page, 'Local', [{ field: 'a' }]);
    await fireTick(page); // seed

    // Out-of-band server change #1.
    await fetch(`${SERVER_URL}/sync/${encodeURIComponent(workspaceId)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        workspaceId,
        exportedAt: Date.now(),
        tables: [
          {
            name: 'V1',
            columns: [{ field: 'x', label: 'X', type: 'string' }],
            rows: [{ x: 'first' }],
          },
        ],
      }),
    });

    // First tick — prompt fires; click No.
    const firstTick = fireTick(page);
    const dialog = page.locator('host-dialogs');
    await expect(dialog.getByText(/server has new data/i)).toBeVisible();
    await dialog.getByRole('button', { name: 'No', exact: true }).click();
    await firstTick;
    await expect(dialog.locator('dialog')).toBeHidden();

    // Second tick on the SAME server state — prompt does NOT reappear.
    await fireTick(page);
    await expect(dialog.locator('dialog')).toBeHidden();

    // Out-of-band server change #2 (different ETag).
    await fetch(`${SERVER_URL}/sync/${encodeURIComponent(workspaceId)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        workspaceId,
        exportedAt: Date.now(),
        tables: [
          {
            name: 'V2',
            columns: [{ field: 'x', label: 'X', type: 'string' }],
            rows: [{ x: 'second' }],
          },
        ],
      }),
    });

    // Third tick — different server state → prompt reappears.
    const thirdTick = fireTick(page);
    await expect(dialog.getByText(/server has new data/i)).toBeVisible();
    await dialog.getByRole('button', { name: 'No', exact: true }).click();
    await thirdTick;
  });
});
