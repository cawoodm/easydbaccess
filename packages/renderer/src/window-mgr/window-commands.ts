/**
 * Bulk window operations used by the command palette's "Windows" commands.
 *
 * These act on *every* open panel — table panels and view-instance panels
 * alike — so a single command affects the whole workspace regardless of
 * which manager opened each window. Both kinds now run on the in-repo panel
 * shell and register in its single registry (`getPanels()`), which already
 * returns panels highest-z-first.
 *
 * Cascade/tile position panels within the *currently visible* region of the
 * pan/zoom canvas: geometry is written in viewport-local coordinates derived
 * from the live pan/zoom transform, so the arranged windows land where the
 * user is actually looking. They write inline geometry, which no jsPanel
 * callback reports, and then ask both window managers to persist the result —
 * an arranged layout used to be lost on the next reload.
 */
import { persistTablePanelGeometry } from './table-window-manager.js';
import { currentPanZoom } from './shell-viewport.js';
import { persistViewWindowGeometry } from './view-window-manager.js';
import { getPanels, type PanelShellEl } from './panel-shell/panel-shell.js';
import { columnSlots, eligibleForArrange, rowSlots, tileSlots, type Rect } from './tile-layout.js';

/** Every open panel, newest-on-top first. */
function allPanels(): PanelShellEl[] {
  return getPanels();
}

export function closeAllWindows(): void {
  for (const p of allPanels()) p.close?.();
}

export function minimizeAllWindows(): void {
  for (const p of allPanels()) p.minimize?.();
}

export function restoreAllWindows(): void {
  for (const p of allPanels()) p.normalize?.();
}

export function maximizeAllWindows(): void {
  for (const p of allPanels()) p.maximize?.();
}

/** Visible canvas rectangle in viewport-local coordinates (accounts for pan/zoom). */
function visibleRect(): { x: number; y: number; w: number; h: number } {
  const container = document.getElementById('easydb-panels');
  const cw = container?.clientWidth ?? window.innerWidth;
  const ch = container?.clientHeight ?? window.innerHeight;
  const pz = currentPanZoom()?.snapshot();
  const scale = pz?.scale && pz.scale > 0 ? pz.scale : 1;
  const tx = pz?.x ?? 0;
  const ty = pz?.y ?? 0;
  return { x: -tx / scale, y: -ty / scale, w: cw / scale, h: ch / scale };
}

function setGeom(p: PanelShellEl, x: number, y: number, w: number, h: number): void {
  p.style.left = `${Math.round(x)}px`;
  p.style.top = `${Math.round(y)}px`;
  p.style.width = `${Math.round(w)}px`;
  p.style.height = `${Math.round(h)}px`;
}

export function cascadeAllWindows(): void {
  // Reverse so the front-most window ends up last (on top) after cascading.
  // Minimized panels are excluded — cascading must not un-minimize a window
  // the user deliberately parked (see `eligibleForArrange`).
  const panels = eligibleForArrange(allPanels()).reverse();
  if (panels.length === 0) return;
  const r = visibleRect();
  const step = 32;
  const w = Math.min(680, Math.max(320, r.w * 0.6));
  const h = Math.min(480, Math.max(240, r.h * 0.6));
  panels.forEach((p, i) => {
    p.normalize?.(); // un-maximizes so the panel can take its cascade slot.
    setGeom(p, r.x + 24 + i * step, r.y + 24 + i * step, w, h);
  });
  persistArrangement();
}

/**
 * Write the arranged rects to the store. Both managers are asked: a bulk command
 * spans table panels and view windows, and each manager persists only its own.
 * Fire-and-forget — the layout is already on screen, and the geometry writes
 * serialize per window (see `geometry-writes.ts`).
 */
function persistArrangement(): void {
  void persistTablePanelGeometry();
  void persistViewWindowGeometry();
}

/** The gap between arranged windows, and around the outside of the layout. */
const GAP = 8;

/**
 * Lay every eligible panel into the slots `slotsFor` computes.
 *
 * Minimized panels are excluded from BOTH the layout and the count driving the
 * maths — otherwise a minimized window would get un-minimized by arranging, and
 * would still leave an empty hole in the layout (see `eligibleForArrange`).
 */
function arrange(slotsFor: (count: number, rect: Rect, gap: number) => Rect[]): void {
  const panels = eligibleForArrange(allPanels()).reverse();
  if (panels.length === 0) return;
  const slots = slotsFor(panels.length, visibleRect(), GAP);
  panels.forEach((p, i) => {
    p.normalize?.(); // un-maximizes so the panel can take its slot.
    const slot = slots[i];
    if (!slot) return; // unreachable — slots has exactly panels.length entries.
    setGeom(p, slot.x, slot.y, slot.w, slot.h);
  });
  persistArrangement();
}

/** A square-ish grid over the visible canvas. */
export function tileAllWindows(): void {
  arrange(tileSlots);
}

/**
 * One column per window, side by side, every one full height.
 *
 * What a tile cannot do: three tables tiled put one of them on a second row, so
 * the rows of the third do not line up with the other two. Full-height columns
 * are for reading the same rows across several tables at once.
 */
export function arrangeInColumns(): void {
  arrange(columnSlots);
}

/** One row per window, stacked down the canvas, every one full width. */
export function arrangeInRows(): void {
  arrange(rowSlots);
}
