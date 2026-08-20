import { test, expect, type Page } from './fixtures.js';

/**
 * TODO § Quick Wins
 * - Every anchored menu is completely inside the viewport.
 *
 * The menus live in `@marccawood/lit-menu`, whose `placeMenu` flips a menu above
 * its anchor when there is no room below, right-aligns it when there is no room
 * to the right, and clamps what is left. That was fixed once (v0.0.375) and
 * shipped with no test, which is why it is being asked for again — so this spec
 * pins the RESULT rather than the arithmetic: whatever the menu decides, its box
 * has to be inside the window.
 *
 * Covered in two ways, because "in general" is the point:
 *
 * 1. **A real menu of the app's own** — the Gist footer button, which is the case
 *    that goes wrong: a menu opening downwards from the bottom edge of the window
 *    has nowhere to go. Every anchored menu in the browser build (Gist, server
 *    sync, Connect with two connectors) goes through one `AnchoredMenu.open`.
 * 2. **Every anchor position**, by opening the app's own menu element on a rect
 *    put at each corner, edge and the middle. That reaches the placements no
 *    button in the current UI sits at — a menu anchored at the top-right, or one
 *    with far more items than any menu here has — and it is still the real
 *    element, with its real CSS and its real measurement.
 *
 * The arithmetic itself is swept separately and DOM-free in
 * `test/renderer/chrome/anchored-menu-placement.test.ts`.
 *
 * The File menu these were first reported against is gone (v0.0.397, now palette
 * commands). What is under test is the menu component, not that one caller.
 */

/** The menu's box, and the window it has to fit inside. */
async function menuBox(page: Page) {
  const menu = page.locator('anchored-menu');
  await expect(menu).toBeVisible();
  const box = await menu.boundingBox();
  const view = page.viewportSize();
  return { box: box!, view: view! };
}

/**
 * Assert the menu is inside the window on all four sides.
 *
 * One pixel of slack, because a fractional device pixel ratio can put a box edge
 * a hair outside a whole-number viewport without any of it being off screen.
 */
function expectInside(box: { x: number; y: number; width: number; height: number }, view: { width: number; height: number }) {
  expect(box.x, 'left edge').toBeGreaterThanOrEqual(-1);
  expect(box.y, 'top edge').toBeGreaterThanOrEqual(-1);
  expect(box.x + box.width, 'right edge').toBeLessThanOrEqual(view.width + 1);
  expect(box.y + box.height, 'bottom edge').toBeLessThanOrEqual(view.height + 1);
}

/** Open the Gist footer menu. */
async function openFooterMenu(page: Page) {
  await page
    .locator('app-shell')
    .getByTitle(/^Gist sync/)
    .click();
}

test('a footer menu opens fully inside the window', async ({ page }) => {
  await openFooterMenu(page);
  const { box, view } = await menuBox(page);
  expectInside(box, view);
  // It really did flip: a menu that started at the footer and grew downwards
  // would have its top below the anchor, near the bottom of the window.
  expect(box.y + box.height).toBeLessThanOrEqual(view.height);
});

test.describe('a window with almost no room', () => {
  // Short enough that a 4-item menu cannot fit below a footer button, and narrow
  // enough that the buttons crowd the right edge.
  test.use({ viewport: { width: 560, height: 380 } });

  test('the menu is still inside the window on every side', async ({ page }) => {
    await openFooterMenu(page);
    const { box, view } = await menuBox(page);
    expectInside(box, view);
  });
});

test.describe('a window shorter than the menu', () => {
  // 200px tall: the menu's own max-height (60vh) leaves 120px, less than four
  // items need, so it has to scroll rather than overflow. This is the case the
  // clamp alone cannot answer — placement puts the box at the top margin, and
  // without a max-height the last items would sit below the bottom edge.
  test.use({ viewport: { width: 900, height: 200 } });

  test('the menu scrolls instead of running off the bottom', async ({ page }) => {
    await openFooterMenu(page);
    const { box, view } = await menuBox(page);
    expectInside(box, view);

    // Scrollable, and every item is reachable by scrolling — which is what makes
    // a clamped menu usable rather than merely on screen.
    const menu = page.locator('anchored-menu');
    const scrollable = await menu.evaluate((el) => {
      const inner = (el.shadowRoot?.querySelector('.menu') ?? el) as HTMLElement;
      return { scrollHeight: inner.scrollHeight, clientHeight: inner.clientHeight };
    });
    expect(scrollable.scrollHeight).toBeGreaterThan(scrollable.clientHeight);
    await expect(page.getByRole('menuitem')).toHaveCount(4);
  });
});

test.describe('a window narrower than the menu wants to be', () => {
  // A phone-width window. The scope menu below carries this app's longest menu
  // labels ("Settings only (views + settings)"), and the menu has a min-width and
  // no max-width — so this is the horizontal version of the same question.
  test.use({ viewport: { width: 320, height: 640 } });

  test('a long-labelled menu does not run off the right edge', async ({ page }) => {
    await openFooterMenu(page);
    // Push opens a second menu — which slice of the workspace to sync — with no
    // network call in between, so this reaches it without touching a gist.
    await page
      .getByRole('menuitem')
      .filter({ has: page.getByText('Push', { exact: true }) })
      .click();

    const { box, view } = await menuBox(page);
    expectInside(box, view);
  });
});

/**
 * Open the app's own menu element on an arbitrary rect.
 *
 * `AnchoredMenu` keeps ONE element, mounted in `<body>` on first use, so opening
 * the Gist menu once puts it there and this can then drive it directly. That is
 * what makes an anchor position no button currently sits at testable at all —
 * and it is still the real element: real CSS, real measurement, real placement.
 *
 * `openMenu` resolves when something is chosen, so the promise is deliberately
 * left hanging; Escape settles it.
 */
async function openMenuAt(page: Page, left: number, top: number, itemCount: number) {
  await page.evaluate(
    ({ left, top, itemCount }) => {
      const el = document.querySelector('anchored-menu') as (HTMLElement & { openMenu(a: DOMRect, i: unknown[]): Promise<unknown> }) | null;
      if (!el) throw new Error('the menu element is not mounted — open one of the app’s menus first');
      const items = Array.from({ length: itemCount }, (_, i) => ({
        id: `i${i}`,
        // Long enough to make the menu wider than a phone window.
        label: `Item ${i + 1} — a label about as long as this app ever writes`,
        icon: 'check',
      }));
      void el.openMenu(new DOMRect(left, top, 90, 28), items);
    },
    { left, top, itemCount },
  );
}

/** Dismiss whatever menu is open, and wait for it to be gone. */
async function closeMenu(page: Page) {
  await page.keyboard.press('Escape');
  await expect(page.locator('anchored-menu')).toBeHidden();
}

for (const view of [
  { name: 'a desktop window', width: 1280, height: 720 },
  { name: 'a phone window', width: 320, height: 480 },
]) {
  test.describe(view.name, () => {
    test.use({ viewport: { width: view.width, height: view.height } });

    test('a menu is inside the window from any anchor position', async ({ page }) => {
      // Mounts the singleton, and covers the app's own footer anchor on the way.
      await openFooterMenu(page);
      const first = await menuBox(page);
      expectInside(first.box, first.view);
      await closeMenu(page);

      const w = 90;
      const h = 28;
      const positions = [
        { name: 'top-left', left: 0, top: 0 },
        { name: 'top-right', left: view.width - w, top: 0 },
        { name: 'bottom-left', left: 0, top: view.height - h },
        { name: 'bottom-right', left: view.width - w, top: view.height - h },
        { name: 'middle', left: Math.round(view.width / 2), top: Math.round(view.height / 2) },
        // Beyond the edge: a stale rect from an element that has since scrolled or
        // moved. The menu still has to land somewhere usable.
        { name: 'past the bottom-right corner', left: view.width + 40, top: view.height + 40 },
      ];

      for (const at of positions) {
        // 12 items is more than any menu in the app, so the box is big on both
        // axes — the interesting case for a corner.
        await openMenuAt(page, at.left, at.top, 12);
        const { box, view: v } = await menuBox(page);
        expect(box.width, `${at.name}: has a box`).toBeGreaterThan(0);
        expectInside(box, v);
        await closeMenu(page);
      }
    });
  });
}
