/**
 * Pan/zoom for the table canvas.
 *
 * The panel-shell windows live in an inner viewport (`#easydb-panels-viewport`)
 * inside the fixed `#easydb-panels` overlay. This controller drives a CSS
 * `translate()/scale()` on that viewport from two input paths:
 *
 * Touch (mobile):
 *   - one finger on the empty canvas background  → pan (translate);
 *   - two fingers anywhere                        → pinch-zoom the canvas;
 *   - double-tap the background                   → reset to 1:1.
 * A one-finger touch that lands on a panel is left alone, so tables still
 * scroll and cells still tap. The overlay only becomes pointer-interactive
 * for touch under `@media (pointer: coarse)`.
 *
 * Mouse (desktop):
 *   - right-button drag anywhere over the canvas  → pan (translate).
 * Left-button drag is untouched, so panel dragging still works.
 * The right-drag handlers are attached at the window level (capture) because
 * the desktop overlay stays `pointer-events:none` so left-clicks fall through
 * to the chrome beneath; window capture still sees the events, and activation
 * is scoped geometrically to the canvas region. The context menu is suppressed
 * only when a drag actually happened — a plain right-click still opens it.
 *
 * Panel geometry is stored in the viewport's own (untransformed) layout
 * coordinates, so the panel shell's drag/resize/clamp math is unaffected by
 * the transform. The one known caveat: while zoomed (scale ≠ 1) a panel
 * titlebar drag moves by raw pointer delta, so it tracks the finger at
 * 1/scale speed — acceptable since panning/zooming to view is the
 * mobile-primary interaction.
 */

export interface PanZoomState {
  x: number;
  y: number;
  scale: number;
}

export const MIN_SCALE = 0.25;
export const MAX_SCALE = 4;

export function clampScale(s: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));
}

/** Translate by a screen-space delta. */
export function panBy(state: PanZoomState, dx: number, dy: number): PanZoomState {
  return { x: state.x + dx, y: state.y + dy, scale: state.scale };
}

/**
 * Scale by `factor` about the point (cx, cy) — coordinates relative to the
 * viewport's origin — keeping the canvas point under (cx, cy) fixed on screen.
 */
export function zoomAround(
  state: PanZoomState,
  factor: number,
  cx: number,
  cy: number,
): PanZoomState {
  const scale = clampScale(state.scale * factor);
  // World point currently under (cx, cy): (screen - translate) / scale.
  const worldX = (cx - state.x) / state.scale;
  const worldY = (cy - state.y) / state.scale;
  // Re-place the translate so that same world point stays under (cx, cy).
  return { x: cx - worldX * scale, y: cy - worldY * scale, scale };
}

const IDENTITY: PanZoomState = { x: 0, y: 0, scale: 1 };

function distance(a: Touch, b: Touch): number {
  return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
}

function onPanel(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest('.jsPanel') != null;
}

/** Live control over the canvas transform, returned by {@link initPanZoom}. */
export interface PanZoomHandle {
  /** Current transform state (copy). */
  snapshot(): PanZoomState;
  /** Snap the canvas back to 1:1 at the origin. */
  reset(): void;
  /** Restore a previously snapshotted transform. */
  restore(s: PanZoomState): void;
  /**
   * Subscribe to transform changes (fires on every pan/zoom/reset/restore with
   * the new state). Returns an unsubscribe fn. Used so a maximized window can
   * counter the canvas transform and stay filling the screen as it pans/zooms.
   */
  subscribe(cb: (s: PanZoomState) => void): () => void;
  /** Detach all listeners. */
  dispose(): void;
}

/**
 * Wire touch pan/zoom on `outer`, transforming `viewport`. Returns a handle for
 * reading/resetting the transform (e.g. so a maximized window can fill the real
 * screen regardless of the current pan/zoom).
 */
export function initPanZoom(outer: HTMLElement, viewport: HTMLElement): PanZoomHandle {
  let state: PanZoomState = { ...IDENTITY };
  viewport.style.transformOrigin = '0 0';
  const listeners = new Set<(s: PanZoomState) => void>();
  const apply = () => {
    viewport.style.transform = `translate(${state.x}px, ${state.y}px) scale(${state.scale})`;
    for (const cb of listeners) cb({ ...state });
  };

  // Gesture bookkeeping.
  let mode: 'none' | 'pan' | 'pinch' = 'none';
  let base: PanZoomState = { ...IDENTITY };
  let startX = 0;
  let startY = 0;
  let startDist = 0;
  // World point under the initial pinch midpoint (kept fixed across the pinch).
  let pinchWorldX = 0;
  let pinchWorldY = 0;
  let lastTapTime = 0;

  const rel = (clientX: number, clientY: number) => {
    const r = outer.getBoundingClientRect();
    return { x: clientX - r.left, y: clientY - r.top };
  };

  const onTouchStart = (e: TouchEvent) => {
    if (e.touches.length === 2) {
      mode = 'pinch';
      base = { ...state };
      const [t0, t1] = [e.touches[0]!, e.touches[1]!];
      startDist = distance(t0, t1) || 1;
      const mid = rel((t0.clientX + t1.clientX) / 2, (t0.clientY + t1.clientY) / 2);
      pinchWorldX = (mid.x - state.x) / state.scale;
      pinchWorldY = (mid.y - state.y) / state.scale;
      e.preventDefault();
      return;
    }
    if (e.touches.length === 1 && !onPanel(e.target)) {
      // Double-tap the background → reset the view.
      const now = e.timeStamp;
      if (now - lastTapTime < 300) {
        state = { ...IDENTITY };
        apply();
        lastTapTime = 0;
        mode = 'none';
        e.preventDefault();
        return;
      }
      lastTapTime = now;
      mode = 'pan';
      base = { ...state };
      startX = e.touches[0]!.clientX;
      startY = e.touches[0]!.clientY;
    } else {
      mode = 'none'; // touch began on a panel — leave it to the panel
    }
  };

  const onTouchMove = (e: TouchEvent) => {
    if (mode === 'pan' && e.touches.length === 1) {
      const t = e.touches[0]!;
      state = panBy(base, t.clientX - startX, t.clientY - startY);
      apply();
      e.preventDefault();
    } else if (mode === 'pinch' && e.touches.length >= 2) {
      const [t0, t1] = [e.touches[0]!, e.touches[1]!];
      const scale = clampScale(base.scale * (distance(t0, t1) / startDist));
      const mid = rel((t0.clientX + t1.clientX) / 2, (t0.clientY + t1.clientY) / 2);
      // Keep the initial world point pinned under the (possibly moved) midpoint
      // so a two-finger gesture pans as well as zooms.
      state = { x: mid.x - pinchWorldX * scale, y: mid.y - pinchWorldY * scale, scale };
      apply();
      e.preventDefault();
    }
  };

  const onTouchEnd = (e: TouchEvent) => {
    if (e.touches.length === 0) mode = 'none';
    else if (e.touches.length === 1 && mode === 'pinch') {
      // Dropped from pinch to one finger — continue as a pan from here.
      mode = 'pan';
      base = { ...state };
      startX = e.touches[0]!.clientX;
      startY = e.touches[0]!.clientY;
    }
  };

  // --- Desktop: right-button drag pans the canvas -------------------------
  //
  // Attached to `window` (capture) rather than `outer`, because on desktop the
  // overlay is `pointer-events:none` so it never receives the mousedown — but
  // a window-capture listener sees every event. We scope activation to the
  // canvas region geometrically (the overlay's rect) so right-clicks on the
  // header/footer chrome are left alone.
  let mousePanning = false;
  let mouseBase: PanZoomState = { ...IDENTITY };
  let mouseStartX = 0;
  let mouseStartY = 0;
  let mouseMoved = false;

  const inCanvas = (clientX: number, clientY: number): boolean => {
    const r = outer.getBoundingClientRect();
    return clientX >= r.left && clientX <= r.right && clientY >= r.top && clientY <= r.bottom;
  };

  const onMouseMove = (e: MouseEvent) => {
    if (!mousePanning) return;
    const dx = e.clientX - mouseStartX;
    const dy = e.clientY - mouseStartY;
    // Movement threshold: a plain right-click (dx≈dy≈0) must still reach the
    // context menu, so don't treat sub-threshold jitter as a pan.
    if (!mouseMoved && Math.hypot(dx, dy) < 4) return;
    mouseMoved = true;
    document.body.style.cursor = 'grabbing';
    state = panBy(mouseBase, dx, dy);
    apply();
    e.preventDefault();
  };

  const endMousePan = () => {
    if (!mousePanning) return;
    mousePanning = false;
    document.body.style.cursor = '';
    window.removeEventListener('mousemove', onMouseMove, true);
    window.removeEventListener('mouseup', onMouseUp, true);
  };

  function onMouseUp(): void {
    endMousePan();
  }

  const onMouseDown = (e: MouseEvent) => {
    if (e.button !== 2) return; // right button only
    if (!inCanvas(e.clientX, e.clientY)) return;
    mousePanning = true;
    mouseMoved = false;
    mouseBase = { ...state };
    mouseStartX = e.clientX;
    mouseStartY = e.clientY;
    window.addEventListener('mousemove', onMouseMove, true);
    window.addEventListener('mouseup', onMouseUp, true);
  };

  // Suppress the context menu only after a real right-drag pan; a plain
  // right-click (mouseMoved stayed false) still opens it.
  const onContextMenu = (e: MouseEvent) => {
    if (mouseMoved) {
      e.preventDefault();
      mouseMoved = false;
    }
  };

  outer.addEventListener('touchstart', onTouchStart, { passive: false });
  outer.addEventListener('touchmove', onTouchMove, { passive: false });
  outer.addEventListener('touchend', onTouchEnd);
  outer.addEventListener('touchcancel', onTouchEnd);
  window.addEventListener('mousedown', onMouseDown, true);
  window.addEventListener('contextmenu', onContextMenu, true);

  return {
    snapshot: () => ({ ...state }),
    reset: () => {
      state = { ...IDENTITY };
      apply();
    },
    restore: (s: PanZoomState) => {
      state = { ...s };
      apply();
    },
    subscribe: (cb: (s: PanZoomState) => void) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    dispose: () => {
      outer.removeEventListener('touchstart', onTouchStart);
      outer.removeEventListener('touchmove', onTouchMove);
      outer.removeEventListener('touchend', onTouchEnd);
      outer.removeEventListener('touchcancel', onTouchEnd);
      window.removeEventListener('mousedown', onMouseDown, true);
      window.removeEventListener('contextmenu', onContextMenu, true);
      endMousePan();
    },
  };
}
