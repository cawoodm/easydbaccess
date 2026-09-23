import { describe, expect, it } from 'vitest';
import { createRegistries, createUiRegistry } from '../../../packages/renderer/src/plugin-host/registries.js';

describe('registerFilterPicker', () => {
  it('registers a tag under a key', () => {
    const r = createRegistries();
    createUiRegistry(r).registerFilterPicker('date', 'date-filter-popover');
    expect(r.filterPickers.get('date')).toBe('date-filter-popover');
  });

  it('unregisters only its own entry', () => {
    const r = createRegistries();
    const ui = createUiRegistry(r);
    const off = ui.registerFilterPicker('date', 'a-tag');
    ui.registerFilterPicker('number', 'b-tag');
    off();
    expect(r.filterPickers.has('date')).toBe(false);
    expect(r.filterPickers.get('number')).toBe('b-tag');
  });

  it('a second registration under the same key replaces the first', () => {
    // A Map, not the append-only array the button slots use: two pickers
    // cannot both own one funnel.
    const r = createRegistries();
    const ui = createUiRegistry(r);
    ui.registerFilterPicker('date', 'first');
    ui.registerFilterPicker('date', 'second');
    expect(r.filterPickers.get('date')).toBe('second');
  });

  it('unregistering a replaced entry does not remove the replacement', () => {
    const r = createRegistries();
    const ui = createUiRegistry(r);
    const off = ui.registerFilterPicker('date', 'first');
    ui.registerFilterPicker('date', 'second');
    off();
    expect(r.filterPickers.get('date')).toBe('second');
  });
});
