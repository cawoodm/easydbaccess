import { test, expect } from './fixtures.js';

/**
 * TODO § UI niceties (the visible-when-it-works pieces)
 * - Material Icons rendered inside buttons (not just text labels)
 * - prominent page-level drag-drop overlay during a file drag
 * - draggable modal dialogs
 *
 * (toast notifications and confirm() live in 01-dialogs.spec.ts.)
 */

test.describe('ui niceties', () => {
  test('header buttons embed Material Icons next to their labels', async ({ page }) => {
    // Sample a few of the well-known header buttons and assert they have an
    // <span class="mi"> sibling alongside the label text. (The Sample-data
    // button is icon-only since v0.0.5 — no accessible name to match — so
    // it's intentionally excluded from this label check.)
    const header = page.locator('app-shell header');
    for (const name of ['New Table', 'Paste CSV']) {
      const btn = header.getByRole('button', { name: new RegExp(name) });
      await expect(btn).toBeVisible();
      // The icon is rendered inside the button as <span class="mi sm">.
      await expect(btn.locator('.mi')).toBeVisible();
    }
  });

  test('header search focuses on open, collapses on click-outside, and sits far-right', async ({
    page,
  }) => {
    const header = page.locator('app-shell header');
    const searchBtn = header.locator('button.icon-btn');

    // The collapsed search icon is the last (right-most) element in the header,
    // to the right of the action buttons (e.g. "New Table").
    const newTableBtn = header.getByRole('button', { name: /New Table/ });
    const [btnBox, searchBox] = await Promise.all([
      newTableBtn.boundingBox(),
      searchBtn.boundingBox(),
    ]);
    expect(btnBox).not.toBeNull();
    expect(searchBox).not.toBeNull();
    expect(searchBox!.x).toBeGreaterThan(btnBox!.x);

    // Opening focuses the freshly-rendered input (autofocus is unreliable here).
    await searchBtn.click();
    const input = header.locator('input.search');
    await expect(input).toBeFocused();

    // Type a query, then click elsewhere (the title). The box blurs and
    // collapses back to the icon; the active filter is preserved, so the icon
    // reports it via title + the `active` class.
    await input.fill('widget');
    await header.locator('strong').click();
    await expect(header.locator('input.search')).toHaveCount(0);
    const collapsed = header.locator('button.icon-btn');
    await expect(collapsed).toHaveClass(/active/);
    await expect(collapsed).toHaveAttribute('title', /Filtering all tables: widget/);

    // Re-opening restores the preserved query, focused.
    await collapsed.click();
    await expect(header.locator('input.search')).toBeFocused();
    await expect(header.locator('input.search')).toHaveValue('widget');
  });

  test('header search has a clear (×) button that empties the query and keeps focus', async ({
    page,
  }) => {
    const header = page.locator('app-shell header');
    await header.locator('button.icon-btn').click();
    const input = header.locator('input.search');
    await input.fill('widget');

    // A clear button appears while there's text; clicking it empties the input,
    // keeps the box open and focused, and doesn't collapse it.
    const clear = header.locator('.search-clear');
    await expect(clear).toBeVisible();
    // The handler is on mousedown (so the input never blurs); dispatch it
    // directly to avoid racing a real click against the button detaching once
    // the query clears.
    await clear.dispatchEvent('mousedown');
    await expect(header.locator('input.search')).toHaveValue('');
    await expect(header.locator('input.search')).toBeFocused();
    // With the query empty the clear button is gone again.
    await expect(header.locator('.search-clear')).toHaveCount(0);
  });

  test('server-sync buttons use the cloud_sync (cloud + refresh) icon', async ({ page }) => {
    const footer = page.locator('app-shell footer');
    const pushBtn = footer.getByRole('button', { name: /Sync ↑/ });
    await expect(pushBtn).toBeVisible();
    await expect(pushBtn.locator('.mi')).toHaveText('cloud_sync');
    const pullBtn = footer.getByRole('button', { name: /Sync ↓/ });
    await expect(pullBtn.locator('.mi')).toHaveText('cloud_sync');
  });

  test('drag-over the app-shell shows the page-level drop overlay', async ({ page }) => {
    const shell = page.locator('app-shell');
    await expect(shell).not.toHaveClass(/drag-over/);

    // Synthesize a dragover containing a file so the shell's hasFiles() guard
    // passes — without a file in dt.types, the overlay correctly stays off.
    await page.evaluate(() => {
      const el = document.querySelector('app-shell')!;
      const dt = new DataTransfer();
      dt.items.add(new File(['x'], 'x.csv', { type: 'text/csv' }));
      el.dispatchEvent(new DragEvent('dragover', { bubbles: true, dataTransfer: dt }));
    });
    await expect(shell).toHaveClass(/drag-over/);

    // Dragleave to a node outside the shell clears the class.
    await page.evaluate(() => {
      const el = document.querySelector('app-shell')!;
      el.dispatchEvent(new DragEvent('dragleave', { bubbles: true }));
    });
    await expect(shell).not.toHaveClass(/drag-over/);
  });

  test('host-dialog modal is draggable via its h2 title', async ({ page }) => {
    // Open an alert to materialize the modal.
    void page.evaluate(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const api = (window as any).__easydb.api;
      void api.ui.dialogs.alert('drag me', 'Movable');
    });

    const dialog = page.locator('host-dialogs dialog');
    await expect(dialog).toBeVisible();

    const before = await dialog.boundingBox();
    expect(before).not.toBeNull();

    // Drag the title bar — makeDialogDraggable hooks pointer events on h2.
    const handle = page.locator('host-dialogs h2');
    const handleBox = await handle.boundingBox();
    expect(handleBox).not.toBeNull();
    const startX = handleBox!.x + handleBox!.width / 2;
    const startY = handleBox!.y + handleBox!.height / 2;
    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(startX + 80, startY + 60, { steps: 10 });
    await page.mouse.up();

    const after = await dialog.boundingBox();
    expect(after).not.toBeNull();
    // The dialog moved by roughly the drag delta. Allow a small tolerance.
    expect(Math.abs(after!.x - before!.x - 80)).toBeLessThan(20);
    expect(Math.abs(after!.y - before!.y - 60)).toBeLessThan(20);

    // Tidy up: dismiss the alert so it doesn't bleed into the next test.
    await page.locator('host-dialogs').getByRole('button', { name: 'OK', exact: true }).click();
  });
});
