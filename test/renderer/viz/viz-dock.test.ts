import { describe, expect, it } from 'vitest';
import type { ViewInstance } from '../../../packages/shared/src/types.js';
import { DEFAULT_PANE_H, dockDescriptor } from '../../../packages/renderer/src/viz/viz-dock.js';

/**
 * The placement rule behind both routes into a docked chart: the Views dialog's
 * Shown-as select and the pop-in button on a visualization window's footer.
 */

function inst(id: string, over: Partial<ViewInstance> = {}): ViewInstance {
  return {
    id,
    workspaceId: 'ws',
    tableId: 't1',
    templateId: 'tpl',
    name: id,
    filters: {},
    visibleColumns: [],
    mapping: {},
    updatedAt: 0,
    ...over,
  } as ViewInstance;
}

function docked(id: string, edge: 'above' | 'below', order: number, tableId = 't1'): ViewInstance {
  return inst(id, { tableId, dock: { host: { kind: 'table', tableId }, edge, size: 200, order } });
}

describe('dockDescriptor', () => {
  it('docks to the named table at the default height', () => {
    const d = dockDescriptor({ instances: [], tableId: 't1', edge: 'above' });
    expect(d).toEqual({ host: { kind: 'table', tableId: 't1' }, edge: 'above', size: DEFAULT_PANE_H, order: 0 });
  });

  it('lands beneath the panes already on that edge', () => {
    const instances = [docked('a', 'above', 0), docked('b', 'above', 1)];
    expect(dockDescriptor({ instances, selfId: 'c', tableId: 't1', edge: 'above' }).order).toBe(2);
  });

  it('counts only the same edge of the same host', () => {
    const instances = [
      docked('a', 'below', 0), // other edge
      docked('b', 'above', 0, 't2'), // other table
      inst('c'), // windowed
    ];
    expect(dockDescriptor({ instances, selfId: 'd', tableId: 't1', edge: 'above' }).order).toBe(0);
  });

  it('does not count itself when it is already docked', () => {
    const instances = [docked('a', 'above', 0)];
    expect(dockDescriptor({ instances, selfId: 'a', tableId: 't1', edge: 'above' }).order).toBe(0);
  });

  it('keeps the height and slot an already-docked pane was dragged to', () => {
    const existing = docked('a', 'above', 3).dock;
    const d = dockDescriptor({ instances: [], selfId: 'a', tableId: 't1', edge: 'above', existing });
    expect(d.size).toBe(200);
    expect(d.order).toBe(3);
  });
});
