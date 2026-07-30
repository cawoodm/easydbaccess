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
 * user is actually looking. These set inline geometry directly (a transient
 * view action) and intentionally don't persist to the store.
 */
import { currentPanZoom } from './jspanel-manager.js';
import { getPanels, type PanelShellEl } from './panel-shell/panel-shell.js';
import { eligibleForArrange, tileSlots } from './tile-layout.js';

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
}

export function tileAllWindows(): void {
  // Minimized panels are excluded from BOTH the layout and the count driving
  // the grid maths — otherwise a minimized window would get un-minimized by
  // tiling, and would still leave an empty hole in the grid (see
  // `eligibleForArrange`).
  const panels = eligibleForArrange(allPanels()).reverse();
  if (panels.length === 0) return;
  const gap = 8;
  const slots = tileSlots(panels.length, visibleRect(), gap);
  panels.forEach((p, i) => {
    p.normalize?.(); // un-maximizes so the panel can take its tile slot.
    const slot = slots[i];
    if (!slot) return; // unreachable — slots has exactly panels.length entries.
    setGeom(p, slot.x, slot.y, slot.w, slot.h);
  });
}
