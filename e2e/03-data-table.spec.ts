import { test, expect } from './fixtures.js';
import {
  addRow,
  bulkAddRows,
  createTable,
  panelDomId,
  readTable,
  waitForPanel,
} from './helpers.js';

/**
 * TODO § Data table rendering
 * - per-column resize handles (drag the right edge of `th`)
 * - column width persistence (`Column.width` on resize stop)
 * - row virtualization for >200 rows (VIRT_THRESHOLD)
 * - null-value cell highlighting
 * - number cells right-aligned
 * - date / datetime inputs when editing
 * - subtle gray × delete button
 */

test.describe('data-table rendering', () => {
  test('per-column resize drag updates and persists width', async ({ page }) => {
    const id = await createTable(page, 'Wide', [{ field: 'a' }, { field: 'b' }]);
    await waitForPanel(page, id);
    await addRow(page, id, { a: 'x', b: 'y' });

    const panel = page.locator(`#${panelDomId(id)}`);
    const th = panel.locator('data-table th').first();
    await expect(th).toBeVisible();
    const startWidth = (await th.boundingBox())?.width ?? 0;
    expect(startWidth).toBeGreaterThan(0);

    // Drag the right-edge resize gutter +120px.
    const handle = th.locator('.col-resize');
    const handleBox = await handle.boundingBox();
    expect(handleBox).not.toBeNull();
    const x = handleBox!.x + handleBox!.width / 2;
    const y = handleBox!.y + handleBox!.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + 120, y, { steps: 10 });
    await page.mouse.up();

    // Width changed live and was persisted to the column record.
    const endWidth = (await th.boundingBox())?.width ?? 0;
    expect(endWidth).toBeGreaterThan(startWidth + 80);

    // onResizeStop is async — the RxDB patch happens after pointerup returns.
    // Poll until the persisted width matches what we see on screen.
    await expect
      .poll(async () => {
        const t = await readTable(page, id);
        return t?.columns.find((c: { field: string }) => c.field === 'a')?.width ?? 0;
      })
      .toBeGreaterThan(startWidth + 80);
  });

  test('resize is exact on a wide many-column table (table-layout: fixed)', async ({ page }) => {
    // Regression: on a content-heavy table wider than its panel, `table-layout:
    // auto` silently ignores <col> widths, so dragging a column "barely moved"
    // it. The first resize now freezes every column's current width and flips
    // the table to `table-layout: fixed`, making the drag exact (1:1).
    const fields = Array.from({ length: 12 }, (_, i) => ({ field: `col${i}` }));
    const id = await createTable(page, 'Wide12', fields);
    await waitForPanel(page, id);
    await bulkAddRows(
      page,
      id,
      Array.from({ length: 15 }, () =>
        Object.fromEntries(fields.map((f) => [f.field, 'a fairly long cell value here'])),
      ),
    );

    const panel = page.locator(`#${panelDomId(id)}`);
    const th = panel.locator('data-table th').first(); // leftmost — always visible
    await expect(th).toBeVisible();
    const startWidth = (await th.boundingBox())?.width ?? 0;

    const handle = th.locator('.col-resize');
    const box = await handle.boundingBox();
    const x = box!.x + box!.width / 2;
    const y = box!.y + box!.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + 150, y, { steps: 15 });
    await page.mouse.up();

    // The column grew by ~150px (not a token few pixels) and the table switched
    // to fixed layout.
    const endWidth = (await th.boundingBox())?.width ?? 0;
    expect(endWidth).toBeGreaterThan(startWidth + 120);

    const layout = await panel
      .locator('data-table')
      .evaluate(
        (el) =>
          getComputedStyle(
            (el as HTMLElement & { shadowRoot: ShadowRoot }).shadowRoot.querySelector('table')!,
          ).tableLayout,
      );
    expect(layout).toBe('fixed');

    // Every column was frozen with a width, and the dragged one persisted.
    await expect
      .poll(async () => {
        const t = await readTable(page, id);
        return t?.columns.filter((c: { width?: number }) => typeof c.width === 'number').length ?? 0;
      })
      .toBe(12);
  });

  test('the th is not draggable — only the grip handle reorders columns', async ({ page }) => {
    // Regression: making the whole <th> draggable (a) turned the entire header
    // cell into a grab surface that covered the sort icon and (b) started a
    // native HTML5 drag on the resize gutter, which hijacks the pointer so the
    // resize silently does nothing. Reorder now lives on a small `.col-grip`
    // handle instead, leaving the rest of the th free for sort + resize.
    const id = await createTable(page, 'Wide', [{ field: 'a' }, { field: 'b' }]);
    await waitForPanel(page, id);
    await addRow(page, id, { a: 'x', b: 'y' });

    const dt = page.locator(`#${panelDomId(id)} data-table`);
    await expect(dt.locator('th').first()).toBeVisible();

    const structure = await dt.evaluate((el) => {
      const root = (el as HTMLElement & { shadowRoot: ShadowRoot }).shadowRoot;
      const th = root.querySelector('thead th') as HTMLElement;
      const grip = th.querySelector('.col-grip') as HTMLElement | null;
      return {
        thDraggable: th.getAttribute('draggable'),
        hasGrip: !!grip,
        gripDraggable: grip?.getAttribute('draggable') ?? null,
      };
    });

    // The th must NOT be draggable (no native drag to hijack the gutter)...
    expect(structure.thDraggable).toBeNull();
    // ...and the dedicated grip carries the reorder drag instead.
    expect(structure.hasGrip).toBe(true);
    expect(structure.gripDraggable).toBe('true');
  });

  test('descending sort keeps empty values at the bottom', async ({ page }) => {
    const id = await createTable(page, 'Scores', [
      { field: 'name' },
      { field: 'score', type: 'number' },
    ]);
    await waitForPanel(page, id);
    await bulkAddRows(page, id, [
      { name: 'Alice', score: 3 },
      { name: 'Bob', score: null },
      { name: 'Carol', score: 1 },
      { name: 'Dave', score: 2 },
    ]);

    const dt = page.locator(`#${panelDomId(id)} data-table`);
    await expect(dt.locator('tbody tr:not(.spacer)')).toHaveCount(4);

    // Click the "score" header twice: none → asc → desc.
    const scoreHeader = dt.locator('thead th', { hasText: 'score' }).locator('.sort-icon');
    await scoreHeader.click();
    await scoreHeader.click();

    // Descending orders the present values 3,2,1 — and the empty score (Bob)
    // stays at the BOTTOM rather than floating to the top.
    const names = await dt.evaluate((el) =>
      [
        ...(el as HTMLElement & { shadowRoot: ShadowRoot }).shadowRoot.querySelectorAll(
          'tbody tr:not(.spacer)',
        ),
      ].map((tr) => tr.querySelector('input')?.value ?? null),
    );
    expect(names).toEqual(['Alice', 'Dave', 'Carol', 'Bob']);
  });

  test('ascending sort puts nulls at the top, ahead of blanks', async ({ page }) => {
    // `k` identifies each row; `label` is the sort column. A null and a blank
    // both render as an empty input, so we read the `k` column to tell rows
    // apart. Expected ascending order of label: null < '' < 'apple' < 'zebra'.
    const id = await createTable(page, 'Nulls', [{ field: 'k' }, { field: 'label' }]);
    await waitForPanel(page, id);
    await bulkAddRows(page, id, [
      { k: 'a', label: 'zebra' },
      { k: 'b', label: null }, // null → top
      { k: 'c', label: '' }, // blank → just after null
      { k: 'd', label: 'apple' },
    ]);

    const dt = page.locator(`#${panelDomId(id)} data-table`);
    await expect(dt.locator('tbody tr:not(.spacer)')).toHaveCount(4);

    // One click on the "label" header → ascending.
    await dt.locator('thead th', { hasText: 'label' }).locator('.sort-icon').click();

    // Read the first cell (k) of each row in render order.
    const ks = await dt.evaluate((el) =>
      [
        ...(el as HTMLElement & { shadowRoot: ShadowRoot }).shadowRoot.querySelectorAll(
          'tbody tr:not(.spacer)',
        ),
      ].map((tr) => tr.querySelector('input')?.value ?? null),
    );
    expect(ks).toEqual(['b', 'c', 'd', 'a']); // null, blank, apple, zebra
  });

  test('loading bar is thick, indeterminate without progress and proportional with it', async ({
    page,
  }) => {
    const id = await createTable(page, 'Prog', [{ field: 'x' }]);
    await waitForPanel(page, id);
    const dt = page.locator(`#${panelDomId(id)} data-table`);
    const fire = (detail: Record<string, unknown>) =>
      page.evaluate(
        (d) => document.dispatchEvent(new CustomEvent('easydb:table-loading', { detail: d })),
        detail,
      );

    // Loading with no fraction → an indeterminate (animated) bar, and it's
    // thicker than the old 3px.
    await fire({ tableId: id, loading: true });
    const bar = dt.locator('.load-bar');
    await expect(bar).toBeVisible();
    expect(
      parseFloat(await bar.evaluate((el) => getComputedStyle(el).height)),
    ).toBeGreaterThanOrEqual(6);
    await expect(dt.locator('.load-bar-fill.determinate')).toHaveCount(0);

    // A 50% fraction → determinate fill spanning ~half the bar's width.
    await fire({ tableId: id, loading: true, progress: 0.5 });
    await expect(dt.locator('.load-bar-fill.determinate')).toHaveCount(1);
    await expect
      .poll(() =>
        dt.locator('.load-bar').evaluate((barEl) => {
          const f = barEl.querySelector('.load-bar-fill') as HTMLElement;
          const pct = f.getBoundingClientRect().width / barEl.getBoundingClientRect().width;
          return Math.round(pct * 100);
        }),
      )
      .toBeGreaterThan(40);

    // Finishing hides the bar.
    await fire({ tableId: id, loading: false });
    await expect(dt.locator('.load-bar')).toHaveCount(0);
  });

  test('column width persists across reload', async ({ page }) => {
    // Two columns so the persisted px width on `x` actually shows up — with a
    // single column at width:100% on the table, the column always fills the
    // container regardless of the persisted value.
    const id = await createTable(page, 'Persist', [{ field: 'x' }, { field: 'y' }]);
    await waitForPanel(page, id);
    await addRow(page, id, { x: 'value', y: 'other' });

    const panel = page.locator(`#${panelDomId(id)}`);
    const th = panel.locator('data-table th').first();
    const startWidth = (await th.boundingBox())?.width ?? 0;

    const handle = th.locator('.col-resize');
    const box = await handle.boundingBox();
    expect(box).not.toBeNull();
    await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
    await page.mouse.down();
    await page.mouse.move(box!.x + box!.width / 2 + 150, box!.y + box!.height / 2, {
      steps: 10,
    });
    await page.mouse.up();

    await expect
      .poll(async () => {
        const t = await readTable(page, id);
        return t?.columns.find((c: { field: string }) => c.field === 'x')?.width ?? 0;
      })
      .toBeGreaterThan(startWidth + 100);

    await page.reload();
    await page.waitForFunction(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      () => Boolean((window as any).__easydb),
    );
    await waitForPanel(page, id);
    const reloadedWidth =
      (
        await page
          .locator(`#${panelDomId(id)} data-table th`)
          .first()
          .boundingBox()
      )?.width ?? 0;
    expect(reloadedWidth).toBeGreaterThan(startWidth + 100);
  });

  test('rows above VIRT_THRESHOLD are virtualized (DOM contains a subset)', async ({ page }) => {
    const id = await createTable(page, 'Big', [{ field: 'n', type: 'number' }]);
    await waitForPanel(page, id);
    // VIRT_THRESHOLD is 200 — 250 forces the virtual slice path.
    await bulkAddRows(
      page,
      id,
      Array.from({ length: 250 }, (_, i) => ({ n: i })),
    );

    const panel = page.locator(`#${panelDomId(id)}`);
    // Wait for the table to settle on a virtualized count (it polls in case
    // rendering catches up over a frame or two).
    await expect
      .poll(async () => panel.locator('data-table tbody tr:not(.spacer)').count())
      .toBeLessThan(250);
    const rendered = await panel.locator('data-table tbody tr:not(.spacer)').count();
    expect(rendered).toBeGreaterThan(0);
    expect(rendered).toBeLessThan(250);

    // At scrollY=0 the top spacer is collapsed (0px), so only the bottom
    // spacer renders. After scrolling down both spacers would be present.
    const spacerCount = await panel.locator('data-table tbody tr.spacer').count();
    expect(spacerCount).toBeGreaterThanOrEqual(1);
    expect(spacerCount).toBeLessThanOrEqual(2);
  });

  test('null cells get the is-null highlight class', async ({ page }) => {
    const id = await createTable(page, 'Sparse', [{ field: 'a' }, { field: 'b' }]);
    await waitForPanel(page, id);
    await addRow(page, id, { a: 'hello', b: null });

    const panel = page.locator(`#${panelDomId(id)}`);
    // First row: cell `a` is NOT null, cell `b` IS null. Use nth() to pick.
    const cellA = panel.locator('data-table tbody tr td').nth(0);
    const cellB = panel.locator('data-table tbody tr td').nth(1);
    await expect(cellA).not.toHaveClass(/is-null/);
    await expect(cellB).toHaveClass(/is-null/);
  });

  test('number cells are right-aligned but the header stays left-aligned', async ({ page }) => {
    const id = await createTable(page, 'Prices', [
      { field: 'name' },
      { field: 'price', type: 'number' },
    ]);
    await waitForPanel(page, id);
    await addRow(page, id, { name: 'apple', price: 1.5 });

    const panel = page.locator(`#${panelDomId(id)}`);
    const priceTh = panel.locator('data-table th').nth(1);
    const priceTd = panel.locator('data-table tbody tr td').nth(1);
    await expect(priceTh).toHaveClass(/t-number/);
    await expect(priceTd).toHaveClass(/t-number/);
    // Digits line up (cell right-aligned) but every column header reads left.
    const cellAlign = await priceTd.evaluate((el) => getComputedStyle(el).textAlign);
    const headerAlign = await priceTh.evaluate((el) => getComputedStyle(el).textAlign);
    expect(cellAlign).toBe('right');
    expect(headerAlign).toBe('left');
  });

  test('date column edits use <input type="date">', async ({ page }) => {
    const id = await createTable(page, 'Events', [
      { field: 'when', type: 'date', renderer: 'date' },
    ]);
    await waitForPanel(page, id);
    await addRow(page, id, { when: '2026-05-23' });

    const panel = page.locator(`#${panelDomId(id)}`);
    const input = panel.locator('data-table tbody tr td input').first();
    await expect(input).toHaveAttribute('type', 'date');
    await expect(input).toHaveValue('2026-05-23');
  });

  test('datetime column edits use <input type="datetime-local">', async ({ page }) => {
    const id = await createTable(page, 'Stamps', [
      { field: 'at', type: 'datetime', renderer: 'datetime' },
    ]);
    await waitForPanel(page, id);
    await addRow(page, id, { at: '2026-05-23T14:30' });

    const panel = page.locator(`#${panelDomId(id)}`);
    const input = panel.locator('data-table tbody tr td input').first();
    await expect(input).toHaveAttribute('type', 'datetime-local');
    await expect(input).toHaveValue('2026-05-23T14:30');
  });

  test('row delete button is subtle gray, darkens on hover, removes the row', async ({ page }) => {
    const id = await createTable(page, 'Trash', [{ field: 'name' }]);
    await waitForPanel(page, id);
    await addRow(page, id, { name: 'Alice' });
    await addRow(page, id, { name: 'Bob' });

    const panel = page.locator(`#${panelDomId(id)}`);
    await expect(panel.locator('data-table tbody tr:not(.spacer)')).toHaveCount(2);

    const deleteBtn = panel.locator('data-table tbody tr button.danger').first();
    await expect(deleteBtn).toBeVisible();

    // Subtle gray base — RxDB/Playwright resolves rgb() not the hex.
    const restColor = await deleteBtn.evaluate((el) => getComputedStyle(el).color);
    expect(restColor).toBe('rgb(156, 163, 175)'); // matches CSS #9ca3af

    // Hover darkens to red — assertion is best-effort because Lit-rendered
    // hover state sometimes needs a frame to repaint.
    await deleteBtn.hover();
    await expect
      .poll(async () => deleteBtn.evaluate((el) => getComputedStyle(el).color))
      .toBe('rgb(239, 68, 68)'); // #ef4444

    // Click → row removed.
    await deleteBtn.click();
    await expect(panel.locator('data-table tbody tr:not(.spacer)')).toHaveCount(1);
  });

  test('cell-link renders mailto: for email values, http(s) for URLs, tel: for phones', async ({
    page,
  }) => {
    const id = await createTable(page, 'Contacts', [{ field: 'contact', renderer: 'link' }]);
    await waitForPanel(page, id);
    await addRow(page, id, { contact: 'alice@example.com' });
    await addRow(page, id, { contact: 'https://example.org' });
    await addRow(page, id, { contact: '+1 (555) 123-4567' });
    await addRow(page, id, { contact: 'not a link at all' });

    const panel = page.locator(`#${panelDomId(id)}`);
    await expect(panel.locator('data-table tbody tr:not(.spacer)')).toHaveCount(4);

    // Email → mailto: anchor, no target=_blank (mail clients handle their own).
    const mailLink = panel.locator('cell-link a[href="mailto:alice@example.com"]');
    await expect(mailLink).toHaveCount(1);
    expect(await mailLink.getAttribute('target')).toBeNull();

    // URL → http(s), opens in a new tab.
    const urlLink = panel.locator('cell-link a[href="https://example.org"]');
    await expect(urlLink).toHaveCount(1);
    expect(await urlLink.getAttribute('target')).toBe('_blank');

    // Phone → tel: with non-digit/+ stripped.
    const telLink = panel.locator('cell-link a[href="tel:+15551234567"]');
    await expect(telLink).toHaveCount(1);

    // Plain text → falls back to a text input, not an anchor.
    // The input's value lives in the attribute, not as text content — locate by it.
    await expect(panel.locator('cell-link input[type="text"]')).toHaveCount(1);
    await expect(panel.locator('cell-link input').nth(0)).toHaveValue('not a link at all');
  });
});
