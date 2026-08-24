// packages/renderer/src/viz/viz-dock.ts
//
// One rule for "where does this pane go", shared by the two ways a visualization
// becomes docked: the Views dialog's Shown-as select, and the pop-in button on a
// visualization window's footer.
//
// It is pure on purpose — the caller brings the instance list and the target
// edge, this decides the `order` and the starting height. Two copies of the
// order rule would drift the moment one of them learned about a second host kind.

import type { ViewDock, ViewInstance } from '@easydb/shared';

/**
 * Opening height of a pane nobody has dragged yet: enough to read a chart,
 * not enough to take the grid over.
 */
export const DEFAULT_PANE_H = 160;

export interface DockDescriptorOptions {
  /** Every instance in the workspace — used to count what is already on the edge. */
  instances: ViewInstance[];
  /** The instance being docked, so it does not count itself. */
  selfId?: string | undefined;
  /** The host table (a projection is a table too, so this needs no second case). */
  tableId: string;
  edge: 'above' | 'below';
  /** The instance's current dock, when it has one — its size/order are kept. */
  existing?: ViewInstance['dock'] | undefined;
}

/**
 * The `dock` descriptor for an instance being docked to a table.
 *
 * `order` is the count of panes already on that edge, so a second chart lands
 * beneath the first rather than fighting it for position 0. An instance that is
 * already docked keeps the height it was dragged to.
 */
export function dockDescriptor({ instances, selfId, tableId, edge, existing }: DockDescriptorOptions): ViewDock {
  const onEdge = instances.filter((i) => i.id !== selfId && i.dock?.edge === edge && i.dock?.host.kind === 'table' && i.dock.host.tableId === tableId).length;
  return {
    host: { kind: 'table', tableId },
    edge,
    size: existing?.size ?? DEFAULT_PANE_H,
    order: existing?.order ?? onEdge,
  };
}
