// packages/renderer/src/util/filter-settings.ts
//
// The `grid:defaultSubstring` setting, and the one place that holds it where the
// filter matchers can read it.
//
// Same shape and the same reason as `util/link-settings.ts`: the `settings`
// plugin REGISTERS the field because it owns the Settings tab, and the matcher
// READS it while painting. Neither may import the other. The read is async and
// every reader is sync — `matchesColumnFilter` runs inside a row loop — so the
// value is resolved ONCE at boot into module state and re-resolved when the
// dialog reports a change.
//
// It differs from `links:protocols` in one way worth stating: that one is
// `user`-scoped on purpose, so opening somebody else's workspace cannot widen
// your own rules. This one is `workspace`-scoped, because it decides what the
// filters stored INSIDE the `.edb` mean. Device-local would make the same file
// show different rows on two machines.

import { SETTINGS_CHANGED_EVENT, type SettingsChangedDetail } from '../db/settings-events.js';
import { GRID_SETTINGS_ID } from '../table/grid-settings.js';

export const DEFAULT_SUBSTRING_KEY = 'defaultSubstring';

/** Just enough of `SettingsApi` to read one value — so a test can pass a fake. */
export interface SettingsReader {
  get<T>(pluginId: string, key: string): Promise<T | undefined>;
}

/**
 * Module state, and the default until boot resolves it.
 *
 * True means a filter value with no `*` and no quotes is a SUBSTRING match,
 * which is what the language has always done — so an unresolved read, a test
 * that never starts the watcher, and a workspace saved before the setting
 * existed all behave exactly as before.
 */
let substringDefault = true;

/** Does a bare filter value mean "contains", rather than "is exactly"? */
export function defaultSubstring(): boolean {
  return substringDefault;
}

/** Set it directly. For tests, and for the boot resolver below. */
export function setDefaultSubstring(on: boolean): void {
  substringDefault = on;
}

/** The setting as stored. Absent ⇒ true, so an old workspace does not change. */
export async function readDefaultSubstring(settings: SettingsReader): Promise<boolean> {
  return (await settings.get<boolean>(GRID_SETTINGS_ID, DEFAULT_SUBSTRING_KEY)) !== false;
}

/**
 * Resolve it now and keep it resolved. Returns an unsubscribe, though nothing
 * calls it: the value is app-wide and lives as long as the page.
 */
export function startFilterDefaults(settings: SettingsReader): () => void {
  void readDefaultSubstring(settings).then(setDefaultSubstring);
  if (typeof document === 'undefined') return () => {};
  const onChange = (e: Event) => {
    const detail = (e as CustomEvent<SettingsChangedDetail>).detail;
    if (detail?.pluginId !== GRID_SETTINGS_ID) return;
    void readDefaultSubstring(settings).then(setDefaultSubstring);
  };
  document.addEventListener(SETTINGS_CHANGED_EVENT, onChange);
  return () => document.removeEventListener(SETTINGS_CHANGED_EVENT, onChange);
}
