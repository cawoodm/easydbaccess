import { describe, expect, it } from 'vitest';
import { ALL_SETTINGS, settingsChangeAffects } from '../../../packages/renderer/src/db/settings-events.js';

/**
 * Every listener of `easydb:settings-changed` filters on its own plugin id, and
 * the obvious way to write that filter — `detail.pluginId !== MINE` — silently
 * drops the one event that means "re-read everything". Adopting a connected
 * folder's device state raises exactly that, so a listener that gets this wrong
 * keeps painting with the settings it booted with.
 */
describe('settingsChangeAffects', () => {
  it('matches the listener’s own plugin', () => {
    expect(settingsChangeAffects({ pluginId: 'grid', key: 'defaultSubstring' }, 'grid')).toBe(true);
  });

  it('ignores another plugin’s write', () => {
    expect(settingsChangeAffects({ pluginId: 'links', key: 'protocols' }, 'grid')).toBe(false);
  });

  it('matches every listener when a whole layer moved', () => {
    expect(settingsChangeAffects({ pluginId: ALL_SETTINGS, key: ALL_SETTINGS }, 'grid')).toBe(true);
    expect(settingsChangeAffects({ pluginId: ALL_SETTINGS, key: ALL_SETTINGS }, 'links')).toBe(true);
  });

  it('matches a named key, and a layer move even though the key is not that key', () => {
    // The caller that asks for one key (`edb-file`'s autosave) still has to hear
    // the layer move, or autosave keeps the value this device had.
    expect(settingsChangeAffects({ pluginId: 'edb-file', key: 'autosave' }, 'edb-file', 'autosave')).toBe(true);
    expect(settingsChangeAffects({ pluginId: 'edb-file', key: 'other' }, 'edb-file', 'autosave')).toBe(false);
    expect(settingsChangeAffects({ pluginId: ALL_SETTINGS, key: ALL_SETTINGS }, 'edb-file', 'autosave')).toBe(true);
  });

  it('is false for an event with no detail', () => {
    expect(settingsChangeAffects(undefined, 'grid')).toBe(false);
  });
});
