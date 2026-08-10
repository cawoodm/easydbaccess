// packages/renderer/src/db/settings-events.ts
//
// "A setting just changed." One document event, raised by whoever writes a
// setting, so a component holding a resolved value can drop it.
//
// It exists because settings have no live query. The store's collections do —
// a grid re-runs its row query on any write — but `api.settings` resolves
// through two layers plus the secrets store, so a component that wants a
// setting either re-reads it on every use or caches a value that goes stale the
// moment someone flips it in the Settings dialog. Re-reading per use is fine for
// a click handler (`readSortDescFirst`) and wrong for a render: the grid would
// have to await a store read to paint a cell.
//
// Deliberately coarse: the detail names which plugin and key changed, and a
// listener that cares about either re-reads what it needs. Nothing carries the
// VALUE, so there is one source of truth and no chance of the event and the
// store disagreeing.

export interface SettingsChangedDetail {
  /** The settings tab / plugin id, e.g. `grid`. */
  pluginId: string;
  key: string;
}

export const SETTINGS_CHANGED_EVENT = 'easydb:settings-changed';

/**
 * Announce a write. A no-op without a `document` — reporting a change must never
 * be the thing that breaks the write it reports on.
 */
export function emitSettingsChanged(pluginId: string, key: string): void {
  if (typeof document === 'undefined') return;
  document.dispatchEvent(new CustomEvent<SettingsChangedDetail>(SETTINGS_CHANGED_EVENT, { detail: { pluginId, key } }));
}
