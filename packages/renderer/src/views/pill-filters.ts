// packages/renderer/src/views/pill-filters.ts
//
// The `pillFilters` layer of a `ViewInstance`: what clicking a `$filter.TOKEN`
// pill adds, kept apart from the view's own snapshotted `filters` so filtering
// by clicking never edits the view's configuration.
//
// Extracted from `views/view-window.ts` when a second caller appeared. A custom
// visualization draws pills too (`viz/viz-tokens.ts`), and when it is windowed —
// or docked to a view window that is not a grid — there is no host grid to narrow,
// so it writes the same layer a view does. Two copies of "add a value and patch
// the instance" would have been two chances to disagree about which layer it goes
// in.
//
// A pane docked to a GRID does not come here at all: it asks the grid through
// `table/pane-actions.ts`, so the filter lives in one place and the grid's own
// funnel is where it shows and where it is cleared.

import { getContext } from '../app-context.js';
import { addPillValue } from './view-render.js';

/**
 * The pill-filter map with one more value on `field`, OR-ed with whatever is
 * already there. Pure — the caller decides whether to persist it.
 */
export function withPillValue(current: Record<string, string> | undefined, field: string, value: string): Record<string, string> {
  return { ...(current ?? {}), [field]: addPillValue(current?.[field], value) };
}

/** Write a pill-filter map to its view instance. */
export async function persistPillFilters(instanceId: string, pillFilters: Record<string, string>): Promise<void> {
  const ctx = await getContext();
  await ctx.store.viewInstances.patch(instanceId, { pillFilters, updatedAt: Date.now() });
}
