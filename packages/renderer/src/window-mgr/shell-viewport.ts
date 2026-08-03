/**
 * The canvas pan/zoom handle, and the tiny read-only adapter every panel takes.
 *
 * This lives in its own module because of who needs it. `shellViewport()` is
 * required by anything that opens a panel — including the `preview` and `html`
 * cell renderers, which are plugins. Importing it from the table window manager
 * pulled that whole module (the data-table element, the panel footer, the table
 * info dialog, the store subscriptions) into a plugin that only wanted to know
 * the current zoom. The handle itself is set once, by `initWindowManager`.
 */
import type { PanZoomHandle } from './panzoom.js';
import type { ShellViewport } from './panel-shell/panel-shell.js';

let panzoom: PanZoomHandle | null = null;

/** Called by the table window manager once the canvas is wired. */
export function setPanZoom(handle: PanZoomHandle | null): void {
  panzoom = handle;
}

/** The live canvas pan/zoom handle, or null before the window manager inits. */
export function currentPanZoom(): PanZoomHandle | null {
  return panzoom;
}

/**
 * Pan/zoom hook handed to every shell panel: scale-aware dragging and the
 * maximize counter-transform both read it. Tolerates a not-yet-initialized
 * panzoom (unit boots, view manager races) by reporting an untransformed canvas.
 */
export function shellViewport(): ShellViewport {
  return {
    getState: () => currentPanZoom()?.snapshot() ?? { x: 0, y: 0, scale: 1 },
    subscribe: (cb) => currentPanZoom()?.subscribe(cb) ?? (() => {}),
  };
}
