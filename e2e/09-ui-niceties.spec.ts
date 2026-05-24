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
    // <span class="mi"> sibling alongside the label text.
    const header = page.locator('app-shell header');
    for (const name of ['New Table', 'Paste CSV', 'Sample data']) {
      const btn = header.getByRole('button', { name: new RegExp(name) });
      await expect(btn).toBeVisible();
      // The icon is rendered inside the button as <span class="mi sm">.
      await expect(btn.locator('.mi')).toBeVisible();
    }
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
    expect(Math.abs((after!.x - before!.x) - 80)).toBeLessThan(20);
    expect(Math.abs((after!.y - before!.y) - 60)).toBeLessThan(20);

    // Tidy up: dismiss the alert so it doesn't bleed into the next test.
    await page.locator('host-dialogs').getByRole('button', { name: 'OK', exact: true }).click();
  });
});
