import { describe, expect, it } from 'vitest';
import { countdownWait, resumeWaitDetail, resumeWaitLabel, secondsLeft, waitFraction } from '../../../packages/renderer/src/import/resume-wait.js';

/**
 * The wait that a rate-limited import spends before resuming.
 *
 * It always resumed on time; what it did not do was SAY so, and a silent minute
 * over an empty grid was reported as "resume after 60s doesn't work". These are
 * the numbers and the words that make the wait visible.
 */

describe('resumeWaitLabel', () => {
  it('names the import and says the rows are safe', () => {
    // Grouped the reader's way, not with a hard-coded separator: this repo's own
    // machines are de-CH, where a thousand is 1’000.
    expect(resumeWaitLabel('plants', 1_234)).toBe(`Import of "plants" paused — ${(1234).toLocaleString()} rows kept`);
    expect(resumeWaitLabel('plants', 1_234)).toContain('rows kept');
  });

  it('counts one row as a row', () => {
    expect(resumeWaitLabel('plants', 1)).toBe('Import of "plants" paused — 1 row kept');
  });

  it('is honest when nothing was salvaged', () => {
    // A resume cursor that failed on its own first page keeps no new rows.
    expect(resumeWaitLabel('plants', 0)).toBe('Import of "plants" paused — 0 rows kept');
  });
});

describe('secondsLeft', () => {
  it('rounds UP, so the last second is not spent reading "0s"', () => {
    expect(secondsLeft(60_000)).toBe(60);
    expect(secondsLeft(59_001)).toBe(60);
    expect(secondsLeft(1)).toBe(1);
    expect(secondsLeft(0)).toBe(0);
  });

  it('never goes negative, because a throttled tab wakes up late', () => {
    // A background tab throttles timers to about one a minute, so the wait can
    // be woken well past its deadline.
    expect(secondsLeft(-5_000)).toBe(0);
  });
});

describe('resumeWaitDetail', () => {
  it('is a countdown', () => {
    expect(resumeWaitDetail(42_400)).toBe('resuming in 43s');
    expect(resumeWaitDetail(0)).toBe('resuming in 0s');
  });
});

describe('waitFraction', () => {
  it('fills as the wait passes', () => {
    expect(waitFraction(0, 60_000)).toBe(0);
    expect(waitFraction(30_000, 60_000)).toBe(0.5);
    expect(waitFraction(60_000, 60_000)).toBe(1);
  });

  it('clamps both ends', () => {
    expect(waitFraction(90_000, 60_000)).toBe(1);
    expect(waitFraction(-1, 60_000)).toBe(0);
  });

  it('treats a zero wait as already over', () => {
    // The e2e seam sets the delay to 0 in places; a 0/0 fraction is NaN, and NaN
    // reaches the progress bar as a width of "NaN%".
    expect(waitFraction(0, 0)).toBe(1);
  });
});

describe('countdownWait', () => {
  it('reports immediately, then until the deadline', async () => {
    const ticks: Array<{ msLeft: number; fraction: number }> = [];
    await countdownWait(60, (t) => ticks.push({ msLeft: t.msLeft, fraction: t.fraction }), 20);
    // The first report is before any waiting, so the bar never shows a stale
    // label for a tick.
    expect(ticks.length).toBeGreaterThanOrEqual(3);
    expect(ticks[0]?.fraction).toBe(0);
    // And the last one is the end of the wait, not a fraction of it.
    expect(ticks[ticks.length - 1]).toEqual({ msLeft: 0, fraction: 1 });
  });

  it('waits at least as long as it was asked to', async () => {
    const started = Date.now();
    await countdownWait(120, () => {}, 20);
    expect(Date.now() - started).toBeGreaterThanOrEqual(115);
  });

  it('returns at once for a zero wait, having reported the end', async () => {
    const ticks: number[] = [];
    await countdownWait(0, (t) => ticks.push(t.fraction));
    expect(ticks).toEqual([1]);
  });
});
