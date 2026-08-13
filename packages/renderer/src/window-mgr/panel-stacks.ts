// packages/renderer/src/window-mgr/panel-stacks.ts
//
// The registry of live content stacks, keyed by host.
//
// It exists to keep the two window managers from importing each other. A docked
// visualization is reconciled by `view-window-manager.ts` (it is a `ViewInstance`,
// so it belongs to that manager's one reconciler), but its HOST is usually a table
// window owned by `table-window-manager.ts`. Without this, the view manager would
// have to reach into the table manager — the coupling `panel-registry.ts` and
// `shell-viewport.ts` already exist to avoid for fronting and pan/zoom.
//
// A stack registers when its panel mounts content and unregisters when the panel
// closes or minimizes. So "is this host available?" is exactly "is it in here",
// and a pane whose host is minimized or closed simply has nowhere to go until it
// comes back — which is the correct behaviour, since a minimized window holds no
// grid to publish rows either.

import type { PanelStack } from './panel-stack.js';
import type { ViewDock } from '@easydb/shared';

const stacks = new Map<string, PanelStack>();

/** Listeners told whenever the set of available hosts changes. */
const listeners = new Set<() => void>();

/** The registry key for a dock host. Same shape as `ViewDock.host`. */
export function hostKey(host: ViewDock['host']): string {
  return host.kind === 'table' ? `table:${host.tableId}` : `view:${host.viewInstanceId}`;
}

export function registerPanelStack(key: string, stack: PanelStack): void {
  stacks.set(key, stack);
  notify();
}

export function unregisterPanelStack(key: string): void {
  if (stacks.delete(key)) notify();
}

export function getPanelStack(key: string): PanelStack | null {
  return stacks.get(key) ?? null;
}

/**
 * Be told when a host appears or disappears.
 *
 * The reconcile that mounts docked panes runs on store changes, but a host panel
 * mounting is not a store change — a table window finishing its boot restore, or
 * being expanded from the dock, has to re-trigger it or its panes never appear.
 */
export function onPanelStacksChanged(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function notify(): void {
  for (const fn of [...listeners]) {
    try {
      fn();
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[panel-stacks] listener failed', err);
    }
  }
}

/** Test seam. */
export function __resetPanelStacks(): void {
  stacks.clear();
  listeners.clear();
}
