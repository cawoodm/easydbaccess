import { describe, expect, it } from 'vitest';
import { BatchPacer } from '../../packages/electron/src/db-import.js';

/**
 * `node:sqlite` is synchronous, so a batch blocks its thread for as long as it
 * takes. A fixed row count cannot bound that — the same 2000 rows measured 30ms
 * on a narrow table and 1.3s on `northwind.db`'s widest — which is why the batch
 * size is derived from a TIME budget instead. The pacer is the conversion, and
 * what matters about it is that a slow table shrinks its batches and a fast one
 * grows them, both within bounds.
 */
describe('BatchPacer', () => {
  it('shrinks the batch when rows turn out to be expensive', () => {
    const pacer = new BatchPacer();
    const first = pacer.size();
    // 500 rows took 400ms — ten times the budget.
    pacer.observe(first, 400);
    expect(pacer.size()).toBeLessThan(first);
  });

  it('grows the batch when rows turn out to be cheap', () => {
    const pacer = new BatchPacer();
    const first = pacer.size();
    pacer.observe(first, 1);
    expect(pacer.size()).toBeGreaterThan(first);
  });

  it('converges on a size that costs about the budget, and stays there', () => {
    const pacer = new BatchPacer();
    // A table costing a flat 0.2ms/row: the budget implies ~200 rows.
    const msPerRow = 0.2;
    for (let i = 0; i < 25; i++) pacer.observe(pacer.size(), pacer.size() * msPerRow);
    const settled = pacer.size();
    expect(settled * msPerRow).toBeGreaterThan(20);
    expect(settled * msPerRow).toBeLessThan(80);

    // Another round at the same cost must not drift away from it.
    pacer.observe(settled, settled * msPerRow);
    expect(Math.abs(pacer.size() - settled)).toBeLessThanOrEqual(settled * 0.1);
  });

  it('stays within its bounds however extreme the measurement', () => {
    const slow = new BatchPacer();
    for (let i = 0; i < 40; i++) slow.observe(slow.size(), 100_000);
    expect(slow.size()).toBe(100); // floor — per-batch overhead would dominate below it

    const fast = new BatchPacer();
    for (let i = 0; i < 40; i++) fast.observe(fast.size(), 0);
    expect(fast.size()).toBe(4000); // ceiling — a batch is live JS objects while written
  });

  it('ignores an empty batch rather than dividing by zero', () => {
    const pacer = new BatchPacer();
    const before = pacer.size();
    pacer.observe(0, 50);
    expect(pacer.size()).toBe(before);
  });
});
