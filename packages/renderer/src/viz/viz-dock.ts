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
import { MIN_PANE_H, paneRows } from '../window-mgr/stack-math.js';

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

// -- moving a pane between rows --------------------------------------------

/**
 * One instance's new dock. Every move answers with a LIST of these, because a
 * pane cannot change rows without changing what the rows around it look like.
 */
export interface DockPatch {
  id: string;
  dock: ViewDock;
}

/** The four moves the pane header offers. */
export type PaneMove = 'join-above' | 'own-row' | 'left' | 'right';

/** A docked instance, narrowed so the layout below can read `dock` without `?`. */
type Docked = ViewInstance & { dock: ViewDock };

/** Two docks describe the same place when host and edge agree. */
function sameEdge(a: ViewDock, b: ViewDock): boolean {
  if (a.edge !== b.edge || a.host.kind !== b.host.kind) return false;
  if (a.host.kind === 'table' && b.host.kind === 'table') return a.host.tableId === b.host.tableId;
  if (a.host.kind === 'view' && b.host.kind === 'view') return a.host.viewInstanceId === b.host.viewInstanceId;
  return false;
}

/** The panes sharing one edge with `self`, `self` included. */
function onSameEdge(instances: readonly ViewInstance[], self: Docked): Docked[] {
  return instances.filter((i): i is Docked => i.dock !== undefined && sameEdge(i.dock, self.dock));
}

/**
 * Which moves are available to this pane right now.
 *
 * The buttons read this rather than working it out themselves, so a disabled
 * button and a move that returns nothing can never disagree. Every answer is
 * false for a pane that is not docked at all.
 */
export function paneMoves(instances: readonly ViewInstance[], selfId: string): Record<PaneMove, boolean> {
  const none = { 'join-above': false, 'own-row': false, left: false, right: false };
  const self = instances.find((i) => i.id === selfId);
  if (!self?.dock) return none;
  const rows = paneRows(onSameEdge(instances, self as Docked).map((i) => i.dock));
  const at = locate(rows, self.dock);
  if (!at) return none;
  const row = rows[at.r] ?? [];
  return {
    'join-above': at.r > 0,
    'own-row': row.length > 1,
    left: at.c > 0,
    right: at.c < row.length - 1,
  };
}

/** Where a dock sits in the grouped rows, by identity. */
function locate(rows: readonly ViewDock[][], dock: ViewDock): { r: number; c: number } | null {
  for (let r = 0; r < rows.length; r++) {
    const c = (rows[r] ?? []).indexOf(dock);
    if (c >= 0) return { r, c };
  }
  return null;
}

/**
 * Apply `move` to the pane `selfId` and say what every pane on its edge becomes.
 *
 * **The whole edge is rewritten with an explicit `row` and `order`.** That is not
 * tidiness: `row` absent means "the value of `order`" (see `stack-math.ts`'s
 * `rowOf`), which is what makes an older dock read back as the column of
 * full-width bands it always was — but the moment two panes share a row, a pane
 * still relying on that fallback would jump rows as soon as its `order` changed.
 * Normalising on the first move retires the fallback for that edge for good.
 *
 * Empty when the move is not available, which is the same answer
 * {@link paneMoves} gives for it.
 */
export function movePane(instances: readonly ViewInstance[], selfId: string, move: PaneMove): DockPatch[] {
  const self = instances.find((i) => i.id === selfId);
  if (!self?.dock) return [];
  const sibs = onSameEdge(instances, self as Docked);
  const byDock = new Map<ViewDock, Docked>(sibs.map((i) => [i.dock, i]));
  const rows = paneRows(sibs.map((i) => i.dock));
  const at = locate(rows, self.dock);
  if (!at) return [];
  const row = rows[at.r];
  if (!row) return [];

  // Rows whose MEMBERSHIP changes give up their weights, so the row divides
  // evenly among its new occupants. A pane that merely swapped places keeps its
  // width — the user moved the pane, not the slot it was in.
  const redivide = new Set<number>();

  if (move === 'join-above') {
    if (at.r === 0) return [];
    const target = rows[at.r - 1];
    if (!target) return [];
    row.splice(at.c, 1);
    target.push(self.dock);
    if (row.length === 0) rows.splice(at.r, 1);
    redivide.add(at.r - 1).add(at.r);
  } else if (move === 'own-row') {
    if (row.length < 2) return [];
    row.splice(at.c, 1);
    rows.splice(at.r + 1, 0, [self.dock]);
    redivide.add(at.r).add(at.r + 1);
  } else {
    const to = move === 'left' ? at.c - 1 : at.c + 1;
    const other = row[to];
    if (!other) return [];
    row[to] = self.dock;
    row[at.c] = other;
  }

  const patches: DockPatch[] = [];
  rows.forEach((r, ri) => {
    // The row's height, now that its membership is settled. It belongs to the
    // row, so every pane in it records the same number — the tallest, because a
    // pane arriving from a taller row must not shrink the one it joins.
    const size = Math.max(...r.map((d) => d.size), MIN_PANE_H);
    r.forEach((dock, ci) => {
      const inst = byDock.get(dock);
      if (!inst) return;
      const next: ViewDock = { ...dock, row: ri, order: ci, size };
      if (redivide.has(ri)) delete next.weight;
      // Unchanged docks are still emitted: the caller writes what it is given and
      // a patch that changes nothing is a no-op upsert, where working out which
      // ones moved would be this rule implemented twice.
      patches.push({ id: inst.id, dock: next });
    });
  });
  return patches;
}
