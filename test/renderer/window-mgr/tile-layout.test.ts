import { describe, expect, it } from 'vitest';
import { MIN_CELL, columnSlots, eligibleForArrange, rowSlots, tileSlots, type Rect } from '../../../packages/renderer/src/window-mgr/tile-layout.js';

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
 * Columns and rows are the two arrangements a square grid cannot express: every
 * window full height side by side, or every window full width stacked. Three
 * tables tiled put one on a second row, where its rows line up with nothing.
 */
describe('columnSlots', () => {
  const rect: Rect = { x: 0, y: 0, w: 1000, h: 800 };
  const gap = 8;

  it('returns an empty array for a zero count', () => {
    expect(columnSlots(0, rect, gap)).toEqual([]);
  });

  it('gives one window the whole rect, same as a tile of one', () => {
    expect(columnSlots(1, rect, gap)).toEqual(tileSlots(1, rect, gap));
  });

  it('gives every window the FULL height, however many there are', () => {
    for (const count of [2, 3, 5, 8]) {
      const full = rect.h - gap * 2;
      for (const slot of columnSlots(count, rect, gap)) {
        expect(slot.h).toBe(full);
        expect(slot.y).toBe(gap);
      }
    }
  });

  it('splits the width evenly and leaves no gap unaccounted for', () => {
    const slots = columnSlots(4, rect, gap);
    const cellW = (rect.w - gap * 5) / 4;
    expect(slots.map((s) => s.w)).toEqual([cellW, cellW, cellW, cellW]);
    expect(slots.map((s) => s.x)).toEqual([gap, gap + cellW + gap, gap + 2 * (cellW + gap), gap + 3 * (cellW + gap)]);
    // The last column's right edge lands one gap short of the rect's, so the
    // outer margin matches the inner ones.
    const last = slots[3]!;
    expect(last.x + last.w).toBe(rect.w - gap);
  });

  it('differs from a tile as soon as a tile would need two rows', () => {
    // 3 windows tile as 2x2. In columns they are 3x1 — the whole point.
    expect(columnSlots(3, rect, gap)).not.toEqual(tileSlots(3, rect, gap));
    expect(new Set(columnSlots(3, rect, gap).map((s) => s.y)).size).toBe(1);
    expect(new Set(tileSlots(3, rect, gap).map((s) => s.y)).size).toBe(2);
  });

  it('stops shrinking at MIN_CELL rather than going negative', () => {
    // 40 windows on a laptop screen: the arithmetic alone gives a negative width,
    // which is not a small window but an invalid style the browser drops. They
    // overlap instead, which is at least usable.
    const slots = columnSlots(40, { x: 0, y: 0, w: 1200, h: 800 }, gap);
    for (const slot of slots) expect(slot.w).toBe(MIN_CELL);
    expect(slots[0]!.x).toBeLessThan(slots[39]!.x);
  });
});

describe('rowSlots', () => {
  const rect: Rect = { x: 0, y: 0, w: 1000, h: 800 };
  const gap = 8;

  it('gives every window the FULL width, one per row', () => {
    const slots = rowSlots(4, rect, gap);
    const cellH = (rect.h - gap * 5) / 4;
    for (const slot of slots) {
      expect(slot.w).toBe(rect.w - gap * 2);
      expect(slot.x).toBe(gap);
      expect(slot.h).toBe(cellH);
    }
    expect(slots.map((s) => s.y)).toEqual([gap, gap + cellH + gap, gap + 2 * (cellH + gap), gap + 3 * (cellH + gap)]);
  });

  it('is the transpose of columnSlots on a square rect', () => {
    const square: Rect = { x: 0, y: 0, w: 900, h: 900 };
    const cols = columnSlots(3, square, gap);
    const rows = rowSlots(3, square, gap);
    expect(rows.map((s) => ({ x: s.y, y: s.x, w: s.h, h: s.w }))).toEqual(cols);
  });

  it('honours the rect offset, so an arrangement lands where the user is looking', () => {
    // The visible rect is in canvas coordinates and moves with the pan.
    const panned: Rect = { x: 500, y: 250, w: 1000, h: 800 };
    expect(rowSlots(2, panned, gap)[0]).toEqual({ x: 508, y: 258, w: 984, h: (800 - gap * 3) / 2 });
  });

  it('stops shrinking at MIN_CELL rather than going negative', () => {
    for (const slot of rowSlots(40, { x: 0, y: 0, w: 1200, h: 800 }, gap)) expect(slot.h).toBe(MIN_CELL);
  });
});
