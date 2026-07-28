/**
 * Re-fit maximized panels whenever the visible canvas changes size.
 *
 * jsPanel sizes a maximized panel ONCE, from its container's clientWidth /
 * clientHeight (`maximize()` in jspanel.js). Its own `onwindowresize` option
 * only attaches a handler when `container === 'window'`; ours is the pan/zoom
 * viewport element, so that option is a no-op for us and nothing re-fits the
 * panel. Resize the browser and a maximized window keeps its old box — it
 * overflows the smaller viewport, or leaves a gap in a bigger one.
 *
 * The fix is to call `maximize()` again: jsPanel deliberately permits that on an
 * an already-maximized panel (see its "onContainerResize wouldn't work" note)
 * and re-reads the container size. `donotfront = true` keeps the z-order — and
 * therefore the persisted front-order stamp — untouched.
 *
 * This works off the DOM (`.jsPanel` elements carry the panel API) so it covers
 * table windows and view windows alike, with no registry to keep in sync.
 *
 * Minimized panels need no work: their replacement bars live in the fixed
 * bottom-left dock, which follows the window on its own.
 */

/** The subset of the jsPanel element API this module drives. */
type MaximizablePanel = HTMLElement & {
  status?: string;
  maximize?: (cb?: unknown, donotfront?: boolean) => void;
};

/** Re-fit every currently-maximized panel to its container's current size. */
export function refitMaximizedPanels(): void {
  for (const el of document.querySelectorAll<MaximizablePanel>('.jsPanel')) {
    if (el.status === 'maximized') el.maximize?.(undefined, true);
  }
}

/**
 * Watch `viewport` and re-fit maximized panels when its layout box changes.
 * A ResizeObserver catches both a browser-window resize and a change in the
 * overlay's header/footer insets (the header wraps on narrow windows).
 *
 * Refits are coalesced into one animation frame, so a drag-resize of the window
 * does at most one refit per frame instead of one per resize event.
 *
 * Returns a stop function.
 */
export function startMaximizedRefit(viewport: HTMLElement): () => void {
  let frame = 0;
  const schedule = (): void => {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      refitMaximizedPanels();
    });
  };

  // The ResizeObserver is the real signal; the window listener is the fallback
  // for environments without one (and costs nothing where both fire, since the
  // refit is idempotent and frame-coalesced).
  const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(schedule) : null;
  ro?.observe(viewport);
  window.addEventListener('resize', schedule);

  return () => {
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    ro?.disconnect();
    window.removeEventListener('resize', schedule);
  };
}
