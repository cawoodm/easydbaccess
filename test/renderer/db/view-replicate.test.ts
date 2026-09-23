import { describe, expect, it } from 'vitest';
import { remapInstance, tableIdMap } from '../../../packages/renderer/src/db/edb/view-replicate.js';
import type { TableDiff } from '../../../packages/shared/src/replicate.js';
import type { ViewInstance } from '../../../packages/shared/src/types.js';

/** A minimal `TableDiff` with both sides present — the only shape `tableIdMap` reads. */
function pairedDiff(name: string, hereId: string, diskId: string): TableDiff {
  return {
    name,
    state: 'same',
    here: { id: hereId, name, updatedAt: 0, rows: 0, lastRowAt: 0 },
    disk: { id: diskId, name, updatedAt: 0, rows: 0, lastRowAt: 0 },
    newer: 'same',
  };
}

/** A minimal `ViewInstance`, with only the fields a test cares about varied by caller. */
function instance(over: Partial<ViewInstance> & Pick<ViewInstance, 'id' | 'tableId'>): ViewInstance {
  return {
    workspaceId: 'ws-here',
    templateId: 'tmpl-1',
    name: 'A view',
    filters: {},
    visibleColumns: [],
    mapping: {},
    updatedAt: 0,
    ...over,
  };
}

describe('tableIdMap', () => {
  it('maps ids both ways for a table both sides have', () => {
    const diffs = [pairedDiff('Alpha', 'here-1', 'disk-1')];
    const { hereToDisk, diskToHere } = tableIdMap(diffs);
    expect(hereToDisk.get('here-1')).toBe('disk-1');
    expect(diskToHere.get('disk-1')).toBe('here-1');
  });

  it('ignores a table only one side has', () => {
    const onlyHere: TableDiff = { name: 'Beta', state: 'here-only', here: { id: 'h', name: 'Beta', updatedAt: 0, rows: 0, lastRowAt: 0 }, newer: 'same' };
    const onlyDisk: TableDiff = { name: 'Gamma', state: 'disk-only', disk: { id: 'd', name: 'Gamma', updatedAt: 0, rows: 0, lastRowAt: 0 }, newer: 'same' };
    const { hereToDisk, diskToHere } = tableIdMap([onlyHere, onlyDisk]);
    expect(hereToDisk.size).toBe(0);
    expect(diskToHere.size).toBe(0);
  });

  it('builds a map from a mix of paired and one-sided diffs', () => {
    const diffs = [
      pairedDiff('Alpha', 'here-1', 'disk-1'),
      { name: 'Beta', state: 'here-only', here: { id: 'h-2', name: 'Beta', updatedAt: 0, rows: 0, lastRowAt: 0 }, newer: 'same' } as TableDiff,
      pairedDiff('Gamma', 'here-3', 'disk-3'),
    ];
    const { hereToDisk, diskToHere } = tableIdMap(diffs);
    expect(hereToDisk.size).toBe(2);
    expect(diskToHere.size).toBe(2);
    expect(hereToDisk.get('here-3')).toBe('disk-3');
  });
});

describe('remapInstance', () => {
  it('remaps tableId through the map', () => {
    const idMap = new Map([['disk-1', 'here-1']]);
    const inst = instance({ id: 'v1', tableId: 'disk-1' });
    const out = remapInstance(inst, idMap, 'ws-target', new Set(['here-1']));
    expect(out?.tableId).toBe('here-1');
  });

  it('passes an unmapped id through unchanged — the two sides already agree on it', () => {
    const idMap = new Map<string, string>();
    const inst = instance({ id: 'v1', tableId: 'same-id' });
    const out = remapInstance(inst, idMap, 'ws-target', new Set(['same-id']));
    expect(out?.tableId).toBe('same-id');
  });

  it('drops the instance when its (remapped) table is absent on the target side', () => {
    const idMap = new Map([['disk-1', 'here-1']]);
    const inst = instance({ id: 'v1', tableId: 'disk-1' });
    const out = remapInstance(inst, idMap, 'ws-target', new Set(['some-other-table']));
    expect(out).toBeNull();
  });

  it('drops only the dock, keeping the instance, when the HOST table is absent but the bound table is present', () => {
    const idMap = new Map([
      ['disk-1', 'here-1'],
      ['disk-2', 'here-2'],
    ]);
    const inst = instance({
      id: 'v1',
      tableId: 'disk-1',
      dock: { host: { kind: 'table', tableId: 'disk-2' }, edge: 'above', size: 200, order: 0 },
    });
    // The bound table (here-1) survives; the docked-into HOST table (here-2) does not.
    const out = remapInstance(inst, idMap, 'ws-target', new Set(['here-1']));
    expect(out).not.toBeNull();
    expect(out?.tableId).toBe('here-1');
    expect(out?.dock).toBeUndefined();
  });

  it('remaps the dock host to the target-side id when it survives', () => {
    const idMap = new Map([
      ['disk-1', 'here-1'],
      ['disk-2', 'here-2'],
    ]);
    const inst = instance({
      id: 'v1',
      tableId: 'disk-1',
      dock: { host: { kind: 'table', tableId: 'disk-2' }, edge: 'below', size: 150, order: 1 },
    });
    const out = remapInstance(inst, idMap, 'ws-target', new Set(['here-1', 'here-2']));
    expect(out?.dock).toEqual({ host: { kind: 'table', tableId: 'here-2' }, edge: 'below', size: 150, order: 1 });
  });

  it('leaves a view-host dock untouched — view-instance ids carry across unchanged', () => {
    const idMap = new Map([['disk-1', 'here-1']]);
    const inst = instance({
      id: 'v1',
      tableId: 'disk-1',
      dock: { host: { kind: 'view', viewInstanceId: 'other-view' }, edge: 'above', size: 100, order: 0 },
    });
    const out = remapInstance(inst, idMap, 'ws-target', new Set(['here-1']));
    expect(out?.dock).toEqual({ host: { kind: 'view', viewInstanceId: 'other-view' }, edge: 'above', size: 100, order: 0 });
  });

  it('rewrites workspaceId to the target side', () => {
    const idMap = new Map<string, string>();
    const inst = instance({ id: 'v1', tableId: 't1', workspaceId: 'ws-source' });
    const out = remapInstance(inst, idMap, 'ws-target', new Set(['t1']));
    expect(out?.workspaceId).toBe('ws-target');
  });
});
