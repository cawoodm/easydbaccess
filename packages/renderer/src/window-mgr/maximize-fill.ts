import type { PanZoomHandle, PanZoomState } from './panzoom.js';

/**
 * Keep a maximized jsPanel filling the visible overlay even though panels live
 * inside the pan/zoom-transformed canvas viewport.
 *
 * jsPanel sizes a maximized panel to the viewport's layout box (left:0, top:0,
 * w/h = clientW/H) — correct in layout, but the viewport's translate()/scale()
 * then offsets and scales it visually, so a panned or zoomed canvas leaves the
 * "maximized" window adrift. We give the panel its own transform that exactly
 * cancels the canvas transform and keep it in sync on every pan/zoom.
 *
 * For canvas transform translate(tx,ty) scale(s), the cancelling panel
 * transform (origin 0 0) is translate(-tx/s, -ty/s) scale(1/s): the panel's
 * (0,0)-(W,H) box then maps back to the overlay's (0,0)-(W,H) on screen.
 *
 * Returns `enter()` / `exit()` to call when the panel becomes / stops being
 * maximized. Both are idempotent.
 */
export function createMaximizeFill(
  panelId: string,
  getPanzoom: () => PanZoomHandle | null,
): { enter: () => void; exit: () => void } {
  let unsub: (() => void) | null = null;
  const apply = (s: PanZoomState): void => {
    const el = document.getElementById(panelId);
    if (!el) return;
    el.style.transformOrigin = '0 0';
    el.style.transform = `translate(${-s.x / s.scale}px, ${-s.y / s.scale}px) scale(${1 / s.scale})`;
  };
  return {
    enter(): void {
      const pz = getPanzoom();
      if (unsub || !pz) return;
      apply(pz.snapshot());
      unsub = pz.subscribe(apply);
    },
    exit(): void {
      unsub?.();
      unsub = null;
      const el = document.getElementById(panelId);
      if (el) {
        el.style.transform = '';
        el.style.transformOrigin = '';
      }
    },
  };
}
