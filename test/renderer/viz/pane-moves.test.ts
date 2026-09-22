import { describe, expect, it } from 'vitest';
import type { ViewDock, ViewInstance } from '@easydb/shared';
import { movePane, paneMoves } from '../../../packages/renderer/src/viz/viz-dock.js';

/**
 * The four moves a docked pane's header offers, as pure rewrites of the edge.
 *
 * Every move answers with a patch per pane on that edge, because a pane cannot
 * change rows without changing what the rows around it look like — and each
 * patch carries an EXPLICIT `row`, which retires the "row absent means order"
 * fallback for that edge. Without that, a pane still relying on the fallback
 * jumps rows the moment its `order` changes.
 */

const HOST = 'tbl-1';

function dock(over: Partial<ViewDock> = {}): ViewDock {
  return { host: { kind: 'table', tableId: HOST }, edge: 'above', size: 160, order: 0, ...over };
}

/** Only the fields the moves read; the rest of a `ViewInstance` is irrelevant. */
function inst(id: string, d: ViewDock | undefined): ViewInstance {
  return { id, dock: d } as unknown as ViewInstance;
}

/** The layout as `[[ids in row 0], [ids in row 1], …]`, read off the patches. */
function layout(patches: readonly { id: string; dock: ViewDock }[]): string[][] {
  const rows: string[][] = [];
  for (const p of patches) {
    const r = p.dock.row ?? -1;
    (rows[r] ??= [])[p.dock.order] = p.id;
  }
  return rows.map((r) => [...r]);
}

/** Three panes, each on a row of its own — what docking three charts gives you. */
const column = [inst('a', dock({ order: 0 })), inst('b', dock({ order: 1 })), inst('c', dock({ order: 2 }))];

describe('paneMoves', () => {
  it('offers nothing to a pane that is not docked', () => {
    expect(paneMoves([inst('a', undefined)], 'a')).toEqual({ 'join-above': false, 'own-row': false, left: false, right: false });
  });

  it('offers nothing for a pane nobody has heard of', () => {
    expect(paneMoves(column, 'zz')['join-above']).toBe(false);
  });

  it('will not join the row above from the first row', () => {
    expect(paneMoves(column, 'a')['join-above']).toBe(false);
    expect(paneMoves(column, 'b')['join-above']).toBe(true);
  });

  it('will not give a row of its own to a pane that already has one', () => {
    expect(paneMoves(column, 'a')['own-row']).toBe(false);
  });

  it('offers left and right only where there is a neighbour to swap with', () => {
    const row = [inst('a', dock({ row: 0, order: 0 })), inst('b', dock({ row: 0, order: 1 }))];
    expect(paneMoves(row, 'a')).toMatchObject({ left: false, right: true, 'own-row': true });
    expect(paneMoves(row, 'b')).toMatchObject({ left: true, right: false });
  });
});

describe('movePane — join the row above', () => {
  it('puts the pane beside the one above it', () => {
    expect(layout(movePane(column, 'b', 'join-above'))).toEqual([['a', 'b'], ['c']]);
  });

  it('closes the row it left rather than leaving an empty band', () => {
    const rows = layout(movePane(column, 'b', 'join-above'));
    expect(rows).toHaveLength(2);
  });

  it('joins a row that already holds two', () => {
    const start = [inst('a', dock({ row: 0, order: 0 })), inst('b', dock({ row: 0, order: 1 })), inst('c', dock({ row: 1, order: 0 }))];
    expect(layout(movePane(start, 'c', 'join-above'))).toEqual([['a', 'b', 'c']]);
  });

  it('does nothing from the first row', () => {
    expect(movePane(column, 'a', 'join-above')).toEqual([]);
  });

  it('drops the weights of both rows, so each divides evenly among its new panes', () => {
    const start = [inst('a', dock({ row: 0, order: 0, weight: 0.8 })), inst('b', dock({ row: 1, order: 0, weight: 0.2 }))];
    for (const p of movePane(start, 'b', 'join-above')) expect(p.dock.weight).toBeUndefined();
  });

  it('gives the joined row one height — the taller of the two', () => {
    const start = [inst('a', dock({ row: 0, order: 0, size: 120 })), inst('b', dock({ row: 1, order: 0, size: 300 }))];
    // A pane arriving from a taller row must not shrink the one it joins.
    for (const p of movePane(start, 'b', 'join-above')) expect(p.dock.size).toBe(300);
  });
});

describe('movePane — give it its own row', () => {
  it('drops the pane onto a new row directly below its old one', () => {
    const start = [inst('a', dock({ row: 0, order: 0 })), inst('b', dock({ row: 0, order: 1 })), inst('c', dock({ row: 1, order: 0 }))];
    expect(layout(movePane(start, 'b', 'own-row'))).toEqual([['a'], ['b'], ['c']]);
  });

  it('does nothing for a pane already alone in its row', () => {
    expect(movePane(column, 'a', 'own-row')).toEqual([]);
  });

  it('is the inverse of joining, for two panes', () => {
    const joined = movePane(column.slice(0, 2), 'b', 'join-above');
    const after = joined.map((p) => inst(p.id, p.dock));
    expect(layout(movePane(after, 'b', 'own-row'))).toEqual([['a'], ['b']]);
  });
});

describe('movePane — left and right', () => {
  const row = [inst('a', dock({ row: 0, order: 0 })), inst('b', dock({ row: 0, order: 1 })), inst('c', dock({ row: 0, order: 2 }))];

  it('swaps with the neighbour on that side', () => {
    expect(layout(movePane(row, 'b', 'left'))).toEqual([['b', 'a', 'c']]);
    expect(layout(movePane(row, 'b', 'right'))).toEqual([['a', 'c', 'b']]);
  });

  it('does nothing at the ends', () => {
    expect(movePane(row, 'a', 'left')).toEqual([]);
    expect(movePane(row, 'c', 'right')).toEqual([]);
  });

  it('keeps each pane its own width: the pane moved, not the slot', () => {
    const weighted = [inst('a', dock({ row: 0, order: 0, weight: 0.7 })), inst('b', dock({ row: 0, order: 1, weight: 0.3 }))];
    const after = movePane(weighted, 'b', 'left');
    expect(after.find((p) => p.id === 'a')?.dock.weight).toBeCloseTo(0.7);
    expect(after.find((p) => p.id === 'b')?.dock.weight).toBeCloseTo(0.3);
  });
});

describe('movePane — what it does not touch', () => {
  it('leaves the other edge alone', () => {
    const both = [inst('a', dock({ edge: 'above', order: 0 })), inst('b', dock({ edge: 'above', order: 1 })), inst('z', dock({ edge: 'below', order: 0 }))];
    const ids = movePane(both, 'b', 'join-above').map((p) => p.id);
    expect(ids).not.toContain('z');
    expect(ids).toEqual(expect.arrayContaining(['a', 'b']));
  });

  it('leaves another table alone', () => {
    const two = [inst('a', dock({ order: 0 })), inst('b', dock({ order: 1 })), inst('z', dock({ host: { kind: 'table', tableId: 'other' }, order: 0 }))];
    expect(movePane(two, 'b', 'join-above').map((p) => p.id)).not.toContain('z');
  });

  it('keeps a pane docked into a VIEW apart from one docked into a table', () => {
    const mixed = [inst('a', dock({ order: 0 })), inst('b', dock({ order: 1 })), inst('v', dock({ host: { kind: 'view', viewInstanceId: 'vi-1' }, order: 0 }))];
    expect(movePane(mixed, 'b', 'join-above').map((p) => p.id)).not.toContain('v');
  });

  it('writes an explicit row onto every pane it touches', () => {
    // The whole point of rewriting the edge: `row` absent means `order`, so a
    // pane left on the fallback would jump rows as soon as its order changed.
    for (const p of movePane(column, 'b', 'join-above')) expect(typeof p.dock.row).toBe('number');
  });

  it('keeps the host and the edge exactly as they were', () => {
    for (const p of movePane(column, 'b', 'join-above')) {
      expect(p.dock.edge).toBe('above');
      expect(p.dock.host).toEqual({ kind: 'table', tableId: HOST });
    }
  });
});
