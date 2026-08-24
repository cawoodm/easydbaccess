// packages/renderer/src/import/resume-wait.ts
//
// Waiting out a rate limit, VISIBLY.
//
// A Datasette import that trips the instance's rate limit offers to wait and
// resume from the page that failed. It waited correctly — and looked broken while
// it did: one toast that vanished after a few seconds, an indeterminate bar, an
// empty grid (the salvaged rows are not written until the whole import ends), and
// then a minute of nothing. "Resume loading data after 60s doesn't work" is what
// that reads as, and there was no way for the user to tell the difference.
//
// So the wait reports itself once a second: what is paused, how many rows are
// already safe, and how long is left.
//
// Pure except for the timer, and the reporting is a callback, so the text and the
// arithmetic are testable without a DOM.

/** How often the countdown reports. A second, because it is a clock. */
const TICK_MS = 1_000;

/** What is paused, and the reassurance that nothing has been thrown away. */
export function resumeWaitLabel(name: string, rowsSoFar: number): string {
  const kept = rowsSoFar === 1 ? '1 row kept' : `${rowsSoFar.toLocaleString()} rows kept`;
  return `Import of "${name}" paused — ${kept}`;
}

/**
 * Whole seconds still to wait, rounded UP.
 *
 * Up, so the last second reads "1s" rather than "0s" for a whole second — a
 * countdown that sits on zero is the thing this exists to avoid. Never negative:
 * a throttled background tab can wake past the deadline.
 */
export function secondsLeft(msLeft: number): number {
  return Math.max(0, Math.ceil(msLeft / 1000));
}

/** The countdown line: `resuming in 42s`. */
export function resumeWaitDetail(msLeft: number): string {
  return `resuming in ${secondsLeft(msLeft)}s`;
}

/** How far through the wait, 0..1. A total of zero is already over. */
export function waitFraction(elapsedMs: number, totalMs: number): number {
  if (totalMs <= 0) return 1;
  return Math.min(1, Math.max(0, elapsedMs / totalMs));
}

/** One report from a wait in progress. */
export interface WaitTick {
  msLeft: number;
  fraction: number;
  detail: string;
}

/**
 * Wait `totalMs`, calling `report` now and then about once a second.
 *
 * Driven by a DEADLINE rather than by counting ticks: a background tab throttles
 * timers to about one a minute, and a countdown that counted its own ticks would
 * claim 58 seconds remained when the minute was already up. `Date.now()` is the
 * only thing that stays true across a throttled sleep.
 *
 * Reports immediately, so the bar carries the full number before the first tick
 * rather than showing a stale label for a second.
 */
export async function countdownWait(totalMs: number, report: (tick: WaitTick) => void, tickMs: number = TICK_MS): Promise<void> {
  const deadline = Date.now() + Math.max(0, totalMs);
  const step = Math.max(1, Math.min(tickMs, Math.max(1, totalMs)));
  for (;;) {
    const msLeft = deadline - Date.now();
    report({ msLeft: Math.max(0, msLeft), fraction: waitFraction(totalMs - Math.max(0, msLeft), totalMs), detail: resumeWaitDetail(Math.max(0, msLeft)) });
    if (msLeft <= 0) return;
    await new Promise<void>((r) => setTimeout(r, Math.min(step, msLeft)));
  }
}
