import { describe, expect, it } from 'vitest';
import { columnSlots, eligibleForArrange, gridSlots, rowSlots, tileSlots, type Rect } from '../../../packages/renderer/src/window-mgr/tile-layout.js';

describe('eligibleForArrange', () => {
  it('excludes minimized panels', () => {
    const panels = [{ status: 'normalized' }, { status: 'minimized' }, { status: 'maximized' }];
    expect(eligibleForArrange(panels)).toEqual([{ status: 'normalized' }, { status: 'maximized' }]);
  });

  it('keeps smallified panels — the collapsed-header state is still on screen', () => {
    const panels = [{ status: 'smallified' }];
    expect(eligibleForArrange(panels)).toEqual(panels);
  });

  it('returns an empty list when every panel is minimized', () => {
    const panels = [{ status: 'minimized' }, { status: 'minimized' }];
    expect(eligibleForArrange(panels)).toEqual([]);
  });
});

describe('tileSlots', () => {
  const rect: Rect = { x: 0, y: 0, w: 1000, h: 800 };
  const gap = 8;

  it('returns an empty array for a zero count', () => {
    expect(tileSlots(0, rect, gap)).toEqual([]);
  });

  it('gives a single panel the whole rect minus the outer gap', () => {
    const slots = tileSlots(1, rect, gap);
    expect(slots).toEqual([{ x: 8, y: 8, w: 984, h: 784 }]);
  });

  it('lays 2 panels side by side in a single row (1 col... 2x1 grid)', () => {
    // ceil(sqrt(2)) = 2 cols, ceil(2/2) = 1 row.
    const slots = tileSlots(2, rect, gap);
    expect(slots).toHaveLength(2);
    const cellW = (rect.w - gap * 3) / 2;
    expect(slots[0]).toEqual({ x: gap, y: gap, w: cellW, h: rect.h - gap * 2 });
    expect(slots[1]).toEqual({ x: gap + cellW + gap, y: gap, w: cellW, h: rect.h - gap * 2 });
  });

  it('lays 3 panels into a 2x2 grid with one empty cell', () => {
    // ceil(sqrt(3)) = 2 cols, ceil(3/2) = 2 rows — same grid as 4 panels.
    const slots3 = tileSlots(3, rect, gap);
    const slots4 = tileSlots(4, rect, gap);
    expect(slots3).toHaveLength(3);
    expect(slots4).toHaveLength(4);
    // The 3 slots that DO get used are identical to the first 3 of a 4-panel grid.
    expect(slots3).toEqual(slots4.slice(0, 3));
  });

  it('lays 4 panels into an exact 2x2 grid', () => {
    const slots = tileSlots(4, rect, gap);
    const cellW = (rect.w - gap * 3) / 2;
    const cellH = (rect.h - gap * 3) / 2;
    expect(slots).toEqual([
      { x: gap, y: gap, w: cellW, h: cellH },
      { x: gap + cellW + gap, y: gap, w: cellW, h: cellH },
      { x: gap, y: gap + cellH + gap, w: cellW, h: cellH },
      { x: gap + cellW + gap, y: gap + cellH + gap, w: cellW, h: cellH },
    ]);
  });

  it('lays 9 panels into an exact 3x3 grid', () => {
    const slots = tileSlots(9, rect, gap);
    expect(slots).toHaveLength(9);
    const cellW = (rect.w - gap * 4) / 3;
    const cellH = (rect.h - gap * 4) / 3;
    // Spot-check corners rather than every cell.
    expect(slots[0]).toEqual({ x: gap, y: gap, w: cellW, h: cellH });
    expect(slots[8]).toEqual({
      x: gap + 2 * (cellW + gap),
      y: gap + 2 * (cellH + gap),
      w: cellW,
      h: cellH,
    });
  });

  it('a minimized entry excluded by eligibleForArrange shrinks the slot count, not just skips a slot', () => {
    const panels = [{ status: 'normalized' }, { status: 'minimized' }, { status: 'normalized' }];
    const eligible = eligibleForArrange(panels);
    expect(eligible).toHaveLength(2);
    // 2 eligible panels tile as a 2x1 grid (see the dedicated 2-panel test),
    // NOT a 2x2 grid with an empty hole for the excluded minimized panel.
    const slots = tileSlots(eligible.length, rect, gap);
    expect(slots).toHaveLength(2);
    const cellW = (rect.w - gap * 3) / 2;
    expect(slots[1]).toEqual({ x: gap + cellW + gap, y: gap, w: cellW, h: rect.h - gap * 2 });
  });
});

/**
 * "Tile" squares the grid up, which is right for a lot of windows and wrong for
 * three tables you are reading across. Those want columns — or rows.
 */
const AREA: Rect = { x: 0, y: 0, w: 1000, h: 600 };
const GAP = 10;

describe('columnSlots', () => {
  it('puts every window side by side, all the same width', () => {
    const slots = columnSlots(3, AREA, GAP);
    expect(slots).toHaveLength(3);
    expect(new Set(slots.map((s) => s.w)).size).toBe(1);
    expect(slots.map((s) => s.x)).toEqual([...slots.map((s) => s.x)].sort((a, b) => a - b));
  });

  it('gives each the full height of the area, gaps aside', () => {
    for (const s of columnSlots(4, AREA, GAP)) {
      expect(s.y).toBe(GAP);
      expect(s.h).toBe(AREA.h - GAP * 2);
    }
  });

  it('leaves the same gap between columns as around them', () => {
    const [a, b] = columnSlots(2, AREA, GAP);
    expect(a!.x).toBe(GAP);
    expect(b!.x - (a!.x + a!.w)).toBeCloseTo(GAP);
    expect(AREA.w - (b!.x + b!.w)).toBeCloseTo(GAP);
  });

  it('is one full-area window when there is only one', () => {
    expect(columnSlots(1, AREA, GAP)).toEqual([{ x: GAP, y: GAP, w: AREA.w - GAP * 2, h: AREA.h - GAP * 2 }]);
  });

  it('has nothing to lay out for no windows', () => {
    expect(columnSlots(0, AREA, GAP)).toEqual([]);
  });
});

describe('rowSlots', () => {
  it('stacks every window, all the same height', () => {
    const slots = rowSlots(3, AREA, GAP);
    expect(slots).toHaveLength(3);
    expect(new Set(slots.map((s) => s.h)).size).toBe(1);
    expect(slots.map((s) => s.y)).toEqual([...slots.map((s) => s.y)].sort((a, b) => a - b));
  });

  it('gives each the full width of the area, gaps aside', () => {
    for (const s of rowSlots(4, AREA, GAP)) {
      expect(s.x).toBe(GAP);
      expect(s.w).toBe(AREA.w - GAP * 2);
    }
  });

  it('is the mirror of columnSlots', () => {
    const cols = columnSlots(3, { x: 0, y: 0, w: 600, h: 600 }, GAP);
    const rows = rowSlots(3, { x: 0, y: 0, w: 600, h: 600 }, GAP);
    expect(rows.map((r) => ({ x: r.y, y: r.x, w: r.h, h: r.w }))).toEqual(cols);
  });
});

describe('gridSlots', () => {
  it('is what all three arrangements are made of', () => {
    expect(gridSlots(4, AREA, GAP, 4)).toEqual(columnSlots(4, AREA, GAP));
    expect(gridSlots(4, AREA, GAP, 1)).toEqual(rowSlots(4, AREA, GAP));
    expect(gridSlots(4, AREA, GAP, 2)).toEqual(tileSlots(4, AREA, GAP));
  });

  it('clamps a column count that would put slots outside the area', () => {
    // Nothing passes these, and a slot outside the visible region is a window
    // the user cannot see — worth being unable to ask for.
    expect(gridSlots(3, AREA, GAP, 99)).toEqual(columnSlots(3, AREA, GAP));
    expect(gridSlots(3, AREA, GAP, 0)).toEqual(rowSlots(3, AREA, GAP));
    expect(gridSlots(3, AREA, GAP, -2)).toEqual(rowSlots(3, AREA, GAP));
  });

  it('fills the last row short rather than stretching it', () => {
    const slots = gridSlots(5, AREA, GAP, 2);
    expect(slots).toHaveLength(5);
    expect(slots[4]!.w).toBe(slots[0]!.w);
  });
});
