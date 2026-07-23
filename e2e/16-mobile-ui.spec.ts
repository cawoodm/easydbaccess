import { test, expect } from './fixtures.js';

/**
 * Mobile UI: the header wraps (title block on its own row, header buttons
 * become icon-only chips below it), and the table canvas pans on a one-finger
 * swipe / zooms on a two-finger pinch. Gestures are dispatched as synthetic
 * TouchEvents so the transform math is exercised without a real device.
 */

test.describe('mobile UI', () => {
  test('header wraps: title takes its own row, button labels go icon-only', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 780 });

    const layout = await page.locator('app-shell').evaluate((el) => {
      const root = (el as HTMLElement & { shadowRoot: ShadowRoot }).shadowRoot;
      const header = root.querySelector('header') as HTMLElement;
      const strong = header.querySelector('strong') as HTMLElement;
      const btns = [...header.querySelectorAll('button.primary')] as HTMLElement[];
      const withIcon = btns.find((b) => b.querySelector('.icon-svg, .mi'));
      const label = withIcon?.querySelector('.btn-label') as HTMLElement | undefined;
      return {
        flexWrap: getComputedStyle(header).flexWrap,
        // title spans (nearly) the full header content width → own row
        titleFullRow: strong.offsetWidth >= header.clientWidth - 48,
        hasIconButton: !!withIcon,
        labelDisplay: label ? getComputedStyle(label).display : 'n/a',
      };
    });

    expect(layout.flexWrap).toBe('wrap');
    expect(layout.titleFullRow).toBe(true);
    expect(layout.hasIconButton).toBe(true);
    expect(layout.labelDisplay).toBe('none'); // icon-only on mobile
  });

  test('pinch zooms and swipe pans the table canvas', async ({ page }) => {
    const result = await page.evaluate(() => {
      const outer = document.getElementById('easydb-panels') as HTMLElement;
      const vp = document.getElementById('easydb-panels-viewport') as HTMLElement;
      const touch = (id: number, x: number, y: number) =>
        new Touch({ identifier: id, target: outer, clientX: x, clientY: y });
      const fire = (type: string, touches: Touch[]) =>
        outer.dispatchEvent(
          new TouchEvent(type, {
            touches,
            changedTouches: touches,
            bubbles: true,
            cancelable: true,
          }),
        );

      // Two-finger pinch outward → zoom in.
      fire('touchstart', [touch(1, 100, 100), touch(2, 200, 200)]);
      fire('touchmove', [touch(1, 60, 60), touch(2, 240, 240)]);
      fire('touchend', []);
      const afterZoom = getComputedStyle(vp).transform;

      // One-finger swipe on the empty background → pan.
      fire('touchstart', [touch(3, 120, 120)]);
      fire('touchmove', [touch(3, 200, 170)]);
      fire('touchend', []);
      const afterPan = getComputedStyle(vp).transform;
      return { afterZoom, afterPan };
    });

    // matrix(a, b, c, d, e, f) — a is scaleX, e/f are translate.
    const scale = Number(result.afterZoom.match(/matrix\(\s*([-\d.]+)/)?.[1]);
    expect(result.afterZoom).not.toBe('none');
    expect(scale).toBeGreaterThan(1); // pinch zoomed in
    expect(result.afterPan).not.toBe(result.afterZoom); // swipe translated the canvas
  });
});
