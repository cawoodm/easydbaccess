import { test, expect } from './fixtures.js';
import { addRow, createTable, panelDomId, waitForPanel } from './helpers.js';

/**
 * TODO § Window manager (jsPanel)
 * - panel title shows row count after table name, e.g. `Inventory (3)`
 * - header-drag visual feedback when reordering columns
 *   (z-order persistence is in 02-general.spec.ts)
 */

test.describe('window manager', () => {
  test('panel title shows row count and updates live', async ({ page }) => {
    const id = await createTable(page, 'Stocks', [{ field: 'sym' }]);
    await waitForPanel(page, id);

    const title = page.locator(`#${panelDomId(id)} .jsPanel-title`);
    await expect(title).toContainText('Stocks (0)');

    await addRow(page, id, { sym: 'AAPL' });
    await expect(title).toContainText('Stocks (1)');

    await addRow(page, id, { sym: 'MSFT' });
    await expect(title).toContainText('Stocks (2)');
  });

  test('panels drag freely off-screen (no boundary clamp)', async ({ page }) => {
    const id = await createTable(page, 'Roamer', [{ field: 'x' }]);
    await waitForPanel(page, id);
    const panel = page.locator(`#${panelDomId(id)}`);
    const titlebar = panel.locator('.jsPanel-titlebar');
    const box = await titlebar.boundingBox();
    expect(box).not.toBeNull();

    // Grab the title (left of the controlbar) and drag hard to the far left,
    // well past the container's left edge. With clamping removed the panel's
    // left goes negative instead of snapping back to 0.
    const grabX = box!.x + 100;
    const grabY = box!.y + box!.height / 2;
    await page.mouse.move(grabX, grabY);
    await page.mouse.down();
    await page.mouse.move(grabX - 60, grabY, { steps: 5 });
    await page.mouse.move(2, grabY, { steps: 10 });
    await page.mouse.up();

    const left = await panel.evaluate((el) => (el as HTMLElement).offsetLeft);
    expect(left).toBeLessThan(0);
  });

  test('right-button drag pans the canvas (desktop)', async ({ page }) => {
    const id = await createTable(page, 'Pannable', [{ field: 'x' }]);
    await waitForPanel(page, id);

    const readTransform = () =>
      page.evaluate(
        () => (document.getElementById('easydb-panels-viewport') as HTMLElement).style.transform,
      );
    const before = await readTransform();

    const outer = page.locator('#easydb-panels');
    const box = await outer.boundingBox();
    expect(box).not.toBeNull();
    const cx = box!.x + box!.width / 2;
    const cy = box!.y + box!.height / 2;

    await page.mouse.move(cx, cy);
    await page.mouse.down({ button: 'right' });
    await page.mouse.move(cx + 120, cy + 80, { steps: 10 });
    await page.mouse.up({ button: 'right' });

    const after = await readTransform();
    expect(after).not.toBe(before);
    // Panned by the drag delta (canvas is at 1:1 on desktop).
    expect(after).toContain('translate(120px, 80px)');
  });

  test('minimizing a table unloads its data-table; restoring remounts it', async ({ page }) => {
    const id = await createTable(page, 'Heavy', [{ field: 'x' }]);
    await waitForPanel(page, id);
    await addRow(page, id, { x: 'a' });

    const domId = panelDomId(id);
    const content = page.locator(`#${domId} .jsPanel-content data-table`);
    await expect(content).toHaveCount(1);

    // Minimize → the data-table is detached (its subscription torn down and
    // rows released from memory).
    await page.evaluate(
      (d) => (document.getElementById(d) as HTMLElement & { minimize(): void }).minimize(),
      domId,
    );
    await expect(content).toHaveCount(0);

    // Restore → a fresh data-table remounts and re-reads the store.
    await page.evaluate(
      (d) => (document.getElementById(d) as HTMLElement & { normalize(): void }).normalize(),
      domId,
    );
    await expect(content).toHaveCount(1);
    await expect(
      page.locator(`#${domId} .jsPanel-content data-table tbody tr:not(.spacer)`),
    ).toHaveCount(1);
  });

  test('a window that restores minimized does not mount its grid until expanded', async ({
    page,
  }) => {
    // Insert a table already flagged minimized, plus a row, then reload so the
    // window manager opens it minimized from persisted geometry.
    const id = await page.evaluate(async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ctx = (window as any).__easydb;
      const tid = crypto.randomUUID();
      await ctx.store.tables.insert({
        id: tid,
        workspaceId: ctx.workspaceId,
        name: 'Sleeper',
        code: 'sleeper',
        columns: [{ field: 'x', label: 'x', type: 'string' }],
        view: 'table',
        windowGeometry: { x: 60, y: 80, w: 400, h: 220, z: 1, minimized: true, maximized: false },
        updatedAt: Date.now(),
      });
      await ctx.store.rows(tid).insert({
        id: crypto.randomUUID(),
        tableId: tid,
        data: { x: 'hi' },
        updatedAt: Date.now(),
      });
      return tid;
    });

    await page.reload();
    await page.waitForFunction(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      () => Boolean((window as any).__easydb),
    );

    const domId = panelDomId(id);
    await page.locator(`#${domId}`).waitFor({ state: 'attached' });
    const grid = page.locator(`#${domId} .jsPanel-content data-table`);

    // Minimized on load → no grid mounted, so nothing is fetched for it.
    await expect(grid).toHaveCount(0);

    // Expand → the grid mounts and loads its row.
    await page.evaluate(
      (d) => (document.getElementById(d) as HTMLElement & { normalize(): void }).normalize(),
      domId,
    );
    await expect(grid).toHaveCount(1);
    await expect(
      page.locator(`#${domId} .jsPanel-content data-table tbody tr:not(.spacer)`),
    ).toHaveCount(1);
  });

  test('tapping the window header blurs an open per-table search, collapsing it', async ({
    page,
  }) => {
    const id = await createTable(page, 'Focusable', [{ field: 'x' }]);
    await waitForPanel(page, id);
    const panel = page.locator(`#${panelDomId(id)}`);
    const search = panel.locator('panel-search');

    // Open the per-table search; its input takes focus.
    await search.getByRole('button').click();
    await expect(search.locator('input')).toBeFocused();

    // Tapping the (now focusable) titlebar pulls focus off the input, so it
    // blurs and collapses back to the icon.
    await panel.locator('.jsPanel-titlebar').dispatchEvent('pointerdown');
    await expect(search.locator('input')).toHaveCount(0);
  });

  test('maximizing keeps the titlebar below the header even when the header wraps', async ({
    page,
  }) => {
    // Narrow enough that the header wraps to two rows (taller than the old
    // hardcoded 48px overlay offset).
    await page.setViewportSize({ width: 560, height: 720 });
    const id = await createTable(page, 'Big', [{ field: 'x' }]);
    await waitForPanel(page, id);

    await page.evaluate(
      (d) => (document.getElementById(d) as HTMLElement & { maximize(): void }).maximize(),
      panelDomId(id),
    );

    const geo = await page.evaluate((domId) => {
      const header = document.querySelector('app-shell')!.shadowRoot!.querySelector('header')!;
      const tb = document.getElementById(domId)!.querySelector('.jsPanel-titlebar')! as HTMLElement;
      return {
        headerBottom: header.getBoundingClientRect().bottom,
        titlebarTop: tb.getBoundingClientRect().top,
        headerHeight: header.getBoundingClientRect().height,
      };
    }, panelDomId(id));

    // Header actually wrapped (proves the scenario), and the maximized titlebar
    // starts at/after the header's bottom — never tucked under it.
    expect(geo.headerHeight).toBeGreaterThan(48);
    expect(geo.titlebarTop).toBeGreaterThanOrEqual(geo.headerBottom - 1);
  });

  test('minimized dock stays below the active table window', async ({ page }) => {
    const idA = await createTable(page, 'Keep', [{ field: 'x' }]);
    await waitForPanel(page, idA);
    const idB = await createTable(page, 'Tuck', [{ field: 'y' }]);
    await waitForPanel(page, idB);

    // Minimize B → it docks at the bottom.
    await page.evaluate(
      (d) => (document.getElementById(d) as HTMLElement & { minimize(): void }).minimize(),
      panelDomId(idB),
    );

    const z = await page.evaluate(() => {
      const dock = document.getElementById('easydb-minimized-dock');
      const viewport = document.getElementById('easydb-panels-viewport');
      const bar = document.querySelector('#easydb-minimized-dock .jsPanel-replacement');
      return {
        dockZ: dock ? Number(getComputedStyle(dock).zIndex) || 0 : -1,
        viewportZ: viewport ? Number(getComputedStyle(viewport).zIndex) || 0 : -1,
        hasBar: !!bar,
      };
    });

    // The minimized bar docks in #easydb-minimized-dock, which sits BELOW the
    // pan/zoom viewport that holds the live windows — so an active table always
    // floats above the minimized dock, never the other way round.
    expect(z.hasBar).toBe(true);
    expect(z.dockZ).toBeLessThan(z.viewportZ);
  });

  test('column reorder drag adds visual-feedback classes mid-drag', async ({ page }) => {
    const id = await createTable(page, 'Reorder', [{ field: 'a' }, { field: 'b' }]);
    await waitForPanel(page, id);
    await addRow(page, id, { a: 'x', b: 'y' });

    // Dispatch dragstart on b's th and dragover on a's th, then assert the
    // visual-feedback classes are on the elements BEFORE dispatching drop.
    // data-table is a Lit element — its class strings update on the next
    // `updateComplete`, so we await it between each dispatch and read the
    // re-queried elements (Lit re-creates them on render).
    const feedback = await page.evaluate(async (domId) => {
      const panel = document.getElementById(domId)!;
      const dt = panel.querySelector('data-table') as HTMLElement & {
        shadowRoot: ShadowRoot;
        updateComplete: Promise<unknown>;
      };
      let ths = dt.shadowRoot.querySelectorAll('thead th');
      const aRect = (ths[0] as HTMLElement).getBoundingClientRect();
      const beforeX = aRect.left + aRect.width / 4;
      const midY = aRect.top + aRect.height / 2;
      const dataTransfer = new DataTransfer();

      (ths[1] as HTMLElement).dispatchEvent(
        new DragEvent('dragstart', { bubbles: true, dataTransfer }),
      );
      await dt.updateComplete;
      ths = dt.shadowRoot.querySelectorAll('thead th');

      (ths[0] as HTMLElement).dispatchEvent(
        new DragEvent('dragover', {
          bubbles: true,
          cancelable: true,
          dataTransfer,
          clientX: beforeX,
          clientY: midY,
        }),
      );
      await dt.updateComplete;
      ths = dt.shadowRoot.querySelectorAll('thead th');

      const snapshot = {
        sourceClasses: (ths[1] as HTMLElement).className,
        targetClasses: (ths[0] as HTMLElement).className,
      };

      (ths[1] as HTMLElement).dispatchEvent(
        new DragEvent('dragend', { bubbles: true, dataTransfer }),
      );
      return snapshot;
    }, panelDomId(id));

    expect(feedback.sourceClasses).toMatch(/drag-source/);
    expect(feedback.targetClasses).toMatch(/drop-before/);
  });
});
