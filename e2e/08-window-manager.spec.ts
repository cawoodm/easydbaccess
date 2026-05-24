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
