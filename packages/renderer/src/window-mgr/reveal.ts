// "Show me this window" — the one behaviour behind every targeted reveal:
// the command palette's Go to <table>, Open on a view, un-hiding a closed
// window. Fronting alone is not enough; a window can be off the panned canvas,
// behind another, minimized, or docked.

import { currentPanZoom } from './shell-viewport.js';
import type { PanelShellEl } from './panel-shell/panel-shell.js';
import { panToReveal } from './reveal-math.js';
import { isMobileViewport } from '../util/viewport.js';

/**
 * Put `panel` in front of the user: restore it if minimized, then either fill the
 * screen (a phone has no room to arrange windows and no way to resize one) or pan
 * the canvas until the window is inside the visible area.
 *
 * The canvas moves, not the window: geometry is persisted, so relocating a window
 * on every "go to" would quietly dismantle a layout the user arranged.
 */
export function revealPanel(panel: PanelShellEl): void {
  if (panel.status === 'minimized') panel.normalize();
  if (isMobileViewport()) {
    if (panel.status !== 'maximized') panel.maximize();
    panel.front();
    return;
  }
  // A maximized window already fills the visible area, wherever the canvas is.
  if (panel.status !== 'maximized') panIntoView(panel);
  panel.front();
}

/** Pan the canvas so `panel`'s rect sits inside the visible area, if it does not. */
function panIntoView(panel: PanelShellEl): void {
  const pz = currentPanZoom();
  const outer = document.getElementById('easydb-panels');
  if (!pz || !outer) return;
  const next = panToReveal(pz.snapshot(), { x: panel.offsetLeft, y: panel.offsetTop, w: panel.offsetWidth, h: panel.offsetHeight }, outer.clientWidth, outer.clientHeight);
  if (next) pz.restore(next);
}
