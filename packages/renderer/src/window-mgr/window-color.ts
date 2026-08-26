// packages/renderer/src/window-mgr/window-color.ts
//
// A window's own titlebar colour, chosen by the user, overriding the one its
// KIND would give it.
//
// The automatic colour says what a window is: every table is a shade of blue,
// a view is teal, a visualization violet (`table-kind.ts`, `view-window-manager.ts`).
// That is worth keeping as the default and worth being able to override, because
// what a window IS stops being the useful distinction once a workspace holds
// fifteen tables and you are looking for one of them.
//
// So an override is a per-window choice, and only that: nothing reads it back to
// infer a kind, and clearing it returns the window to its kind's colour rather
// than to a stored "normal".
//
// Stored in the `settings` collection under one key per window, NOT on the
// `Table` / `ViewInstance` record beside `windowGeometry`. Two reasons: it needs
// no change to the stored shape of a table, and a settings key is reachable by a
// plugin, which the titlebar itself is not yet. The colour is workspace-scoped
// either way, so it travels with the workspace like the window layout does.
//
// Pure, apart from the two store calls at the bottom.

import type { DataStore } from '@easydb/shared';

/** One key per window: `window-color:<table or view instance id>`. */
const PREFIX = 'window-color:';

export function windowColorKey(windowId: string): string {
  return `${PREFIX}${windowId}`;
}

/** One offerable colour. `value: null` is "whatever this window's kind says". */
export interface WindowColorChoice {
  id: string;
  label: string;
  value: string | null;
}

/**
 * What the picker offers.
 *
 * Deliberately a short list of distinct HUES rather than a full colour wheel. The
 * point of an override is to tell two windows apart at a glance across a zoomed-
 * out canvas, and a free colour picker mostly produces neighbouring shades that
 * fail at exactly that. Every value clears WCAG AA against the white titlebar
 * text, which is the same rule the kind palette holds itself to — a titlebar the
 * user cannot read is not a customization.
 *
 * The kind blues are NOT offered. Painting a view in table-blue would make the
 * one thing the automatic colour still says come out wrong.
 */
export const WINDOW_COLORS: readonly WindowColorChoice[] = [
  { id: 'default', label: 'Default for this kind', value: null },
  { id: 'slate', label: 'Slate', value: '#334155' },
  { id: 'teal', label: 'Teal', value: '#0f766e' },
  { id: 'green', label: 'Green', value: '#15803d' },
  { id: 'olive', label: 'Olive', value: '#4d7c0f' },
  { id: 'amber', label: 'Amber', value: '#b45309' },
  { id: 'red', label: 'Red', value: '#b91c1c' },
  { id: 'pink', label: 'Pink', value: '#a21caf' },
  { id: 'violet', label: 'Violet', value: '#6d28d9' },
];

/** The colour a menu id means, or `undefined` for an id nothing offers. */
export function colorForChoice(id: string): string | null | undefined {
  const found = WINDOW_COLORS.find((c) => c.id === id);
  return found ? found.value : undefined;
}

/** The choice a stored value corresponds to, for ticking the current one. */
export function choiceForColor(color: string | null | undefined): string {
  if (!color) return 'default';
  const found = WINDOW_COLORS.find((c) => c.value?.toLowerCase() === color.toLowerCase());
  return found ? found.id : 'custom';
}

/** The palette glyph on the titlebar button. */
export const PALETTE_ICON =
  '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" role="img" aria-hidden="true">' +
  '<path d="M12 21a9 9 0 1 1 9-9c0 2-1.6 3-3 3h-1.5a2 2 0 0 0-1.3 3.5A1.6 1.6 0 0 1 12 21Z"/>' +
  '<circle cx="8" cy="9.5" r="1.1" fill="currentColor" stroke="none"/>' +
  '<circle cx="12" cy="7" r="1.1" fill="currentColor" stroke="none"/>' +
  '<circle cx="16" cy="9.5" r="1.1" fill="currentColor" stroke="none"/>' +
  '</svg>';

/** This window's stored override, or null when it has none. */
export async function readWindowColor(store: DataStore, windowId: string): Promise<string | null> {
  try {
    const rec = await store.settings.findOne(windowColorKey(windowId));
    const value = (rec as { value?: unknown } | null | undefined)?.value;
    return typeof value === 'string' && value.trim() ? value : null;
  } catch {
    // A colour is not worth failing to open a window over.
    return null;
  }
}

/**
 * Write the override, or remove it for the default.
 *
 * The default is stored as an ABSENT key rather than an empty string, so "this
 * window follows its kind" cannot drift apart from "nobody has chosen yet" — the
 * two are the same state and there is no way to tell them apart usefully.
 */
export async function writeWindowColor(store: DataStore, windowId: string, color: string | null): Promise<void> {
  const name = windowColorKey(windowId);
  if (color) await store.settings.upsert({ name, value: color });
  else await store.settings.remove(name);
}
