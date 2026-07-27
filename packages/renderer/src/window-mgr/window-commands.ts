/**
 * Bulk window operations used by the command palette's "Windows" commands.
 *
 * These act on *every* open jsPanel — table panels and view-instance panels
 * alike — via jsPanel's global `getPanels()` registry, so a single command
 * affects the whole workspace regardless of which manager opened each window.
 *
 * Cascade/tile position panels within the *currently visible* region of the
 * pan/zoom canvas: geometry is written in viewport-local coordinates derived
 * from the live pan/zoom transform, so the arranged windows land where the
 * user is actually looking. These set inline geometry directly (a transient
 * view action) and intentionally don't persist to the store.
 */
// @ts-expect-error — jspanel4 ships no types
import { jsPanel } from 'jspanel4/es6module/jspanel.js';
import { currentPanZoom } from './jspanel-manager.js';

type PanelEl = HTMLElement & {
  close?: () => void;
  minimize?: () => void;
  maximize?: () => void;
  normalize?: () => void;
};

/** Every open panel, newest-on-top first (jsPanel's `getPanels` z-order). */
function allPanels(): PanelEl[] {
  const getPanels = (jsPanel as unknown as { getPanels?: () => ArrayLike<PanelEl> }).getPanels;
  if (typeof getPanels !== 'function') return [];
  return Array.from(getPanels.call(jsPanel) ?? []);
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

function setGeom(p: PanelEl, x: number, y: number, w: number, h: number): void {
  p.style.left = `${Math.round(x)}px`;
  p.style.top = `${Math.round(y)}px`;
  p.style.width = `${Math.round(w)}px`;
  p.style.height = `${Math.round(h)}px`;
}

export function cascadeAllWindows(): void {
  // Reverse so the front-most window ends up last (on top) after cascading.
  const panels = allPanels().reverse();
  if (panels.length === 0) return;
  const r = visibleRect();
  const step = 32;
  const w = Math.min(680, Math.max(320, r.w * 0.6));
  const h = Math.min(480, Math.max(240, r.h * 0.6));
  panels.forEach((p, i) => {
    p.normalize?.();
    setGeom(p, r.x + 24 + i * step, r.y + 24 + i * step, w, h);
  });
}

export function tileAllWindows(): void {
  const panels = allPanels().reverse();
  const n = panels.length;
  if (n === 0) return;
  const r = visibleRect();
  const cols = Math.ceil(Math.sqrt(n));
  const rows = Math.ceil(n / cols);
  const gap = 8;
  const cellW = (r.w - gap * (cols + 1)) / cols;
  const cellH = (r.h - gap * (rows + 1)) / rows;
  panels.forEach((p, i) => {
    p.normalize?.();
    const col = i % cols;
    const row = Math.floor(i / cols);
    setGeom(p, r.x + gap + col * (cellW + gap), r.y + gap + row * (cellH + gap), cellW, cellH);
  });
}
