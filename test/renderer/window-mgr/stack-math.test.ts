import { describe, expect, it } from 'vitest';
import { clampPaneSize, fitPanes, MIN_PANE_H, MIN_PRIMARY_H, orderPanes, resizedPaneSize } from '../../../packages/renderer/src/window-mgr/stack-math.js';

describe('clampPaneSize', () => {
  it('passes through a size that fits', () => {
    expect(clampPaneSize(120, 400, 0)).toBe(120);
  });

  it('never squeezes the primary content below its floor', () => {
    // 400 tall, nothing else docked ⇒ a pane may take 400 - MIN_PRIMARY_H.
    expect(clampPaneSize(9999, 400, 0)).toBe(400 - MIN_PRIMARY_H);
  });

  it('accounts for the other panes already docked', () => {
    expect(clampPaneSize(9999, 400, 100)).toBe(400 - 100 - MIN_PRIMARY_H);
  });

  it('never returns less than a usable pane, even with no room', () => {
    // A container too short for its panes is the next resize to fix; collapsing
    // to zero would hide that the pane is there at all.
    expect(clampPaneSize(10, 100, 0)).toBe(MIN_PANE_H);
    expect(clampPaneSize(300, 60, 0)).toBe(MIN_PANE_H);
  });

  it('rounds to whole pixels', () => {
    expect(clampPaneSize(120.6, 400, 0)).toBe(121);
  });

  it('survives a non-finite request', () => {
    expect(clampPaneSize(Number.NaN, 400, 0)).toBe(MIN_PANE_H);
  });

  it('honours a caller-supplied primary floor', () => {
    expect(clampPaneSize(9999, 400, 0, 200)).toBe(200);
  });
});

describe('resizedPaneSize', () => {
  it('grows a pane docked above when the splitter is dragged down', () => {
    expect(resizedPaneSize(100, 30, 'above', 500, 0)).toBe(130);
  });

  it('shrinks a pane docked below when the splitter is dragged down', () => {
    // The splitter is between pane and primary in both cases, but the pane is on
    // the other side of it — so the same gesture means the opposite thing.
    expect(resizedPaneSize(100, 30, 'below', 500, 0)).toBe(70);
  });

  it('grows a pane docked below when dragged up', () => {
    expect(resizedPaneSize(100, -30, 'below', 500, 0)).toBe(130);
  });

  it('clamps mid-drag rather than letting the pointer run away', () => {
    expect(resizedPaneSize(100, 5000, 'above', 300, 0)).toBe(300 - MIN_PRIMARY_H);
    expect(resizedPaneSize(100, -5000, 'above', 300, 0)).toBe(MIN_PANE_H);
  });
});

describe('fitPanes', () => {
  it('leaves panes alone when they already fit', () => {
    expect(fitPanes([100, 80], 400)).toEqual([100, 80]);
  });

  it('takes room from the tall pane and leaves the short one alone', () => {
    // 300 + 60 = 360 against a budget of 400 - 80 = 320: 40 too many, and all of
    // it comes off the big one. A small pane never pays for a big one.
    expect(fitPanes([300, 60], 400)).toEqual([260, 60]);
  });

  it('caps equally tall panes equally instead of flooring one of them', () => {
    // The bug this pins: taking the whole excess off "the largest" turned
    // [300, 300] in a 400px window into [48, 272] — not a shrink, a deletion.
    const out = fitPanes([300, 300], 400);
    expect(out.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(400 - MIN_PRIMARY_H);
    expect(Math.abs((out[0] as number) - (out[1] as number))).toBeLessThanOrEqual(1);
    for (const s of out) expect(s).toBeGreaterThan(MIN_PANE_H);
  });

  it('caps three unequal panes to a common ceiling, sparing the short one', () => {
    // Budget 500 - 80 = 420. Cap at 190 ⇒ 40 + 190 + 190 = 420.
    expect(fitPanes([40, 300, 260], 500)).toEqual([48, 186, 186]);
  });

  it('floors every pane when there is no budget at all', () => {
    expect(fitPanes([200, 200], 40)).toEqual([MIN_PANE_H, MIN_PANE_H]);
  });

  it('never returns a pane below the minimum', () => {
    for (const s of fitPanes([500, 500, 500], 300)) expect(s).toBeGreaterThanOrEqual(MIN_PANE_H);
  });

  it('handles no panes', () => {
    expect(fitPanes([], 400)).toEqual([]);
  });
});

describe('orderPanes', () => {
  it('sorts ascending by order', () => {
    expect(orderPanes([{ order: 2 }, { order: 0 }, { order: 1 }]).map((p) => p.order)).toEqual([0, 1, 2]);
  });

  it('is stable for equal orders, so panes do not shuffle between renders', () => {
    const a = { order: 0, id: 'a' };
    const b = { order: 0, id: 'b' };
    expect(orderPanes([a, b]).map((p) => p.id)).toEqual(['a', 'b']);
    expect(orderPanes([b, a]).map((p) => p.id)).toEqual(['b', 'a']);
  });
});
