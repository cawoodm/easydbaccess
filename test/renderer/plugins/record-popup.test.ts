import { describe, it, expect, beforeEach } from 'vitest';
import { __resetRecordPopup, openRecordPopup, provideRecordPopup, recordPopupWanted } from '../../../packages/renderer/src/plugins/record-popup.js';

/**
 * The second hand-off in the double-click chain — see `plugins/record-popup.ts`.
 *
 * What matters is the BOOLEAN: `edit-record` owns the gesture and only stands
 * down when this says the window actually opened. Get that wrong in either
 * direction and one double-click either opens two things or nothing.
 */

beforeEach(() => __resetRecordPopup());

describe('recordPopupWanted', () => {
  it('is false with nothing registered', () => {
    // The Record visualization switched off. `edit-record` then opens the form,
    // exactly as it did before the window existed.
    expect(recordPopupWanted()).toBe(false);
  });

  it('is true once an opener is offered', () => {
    provideRecordPopup(() => undefined);
    expect(recordPopupWanted()).toBe(true);
  });
});

describe('openRecordPopup', () => {
  it('calls the opener with both ids and reports that it handled it', () => {
    const calls: Array<[string, string]> = [];
    provideRecordPopup((t, r) => calls.push([t, r]));
    expect(openRecordPopup('t-1', 'r-1')).toBe(true);
    expect(calls).toEqual([['t-1', 'r-1']]);
  });

  it('reports false with no opener, and calls nothing', () => {
    expect(openRecordPopup('t-1', 'r-1')).toBe(false);
  });

  it('refuses a missing id rather than opening a window on nothing', () => {
    let called = 0;
    provideRecordPopup(() => called++);
    expect(openRecordPopup('', 'r-1')).toBe(false);
    expect(openRecordPopup('t-1', '')).toBe(false);
    expect(called).toBe(0);
  });
});

describe('the release', () => {
  it('stops the window being offered', () => {
    const release = provideRecordPopup(() => undefined);
    release();
    expect(recordPopupWanted()).toBe(false);
    expect(openRecordPopup('t-1', 'r-1')).toBe(false);
  });

  it('does not release a LATER opener', () => {
    // A plugin reloaded in place replaces its own opener; the stale release
    // must then be a no-op rather than switching the new one off.
    const stale = provideRecordPopup(() => undefined);
    let called = 0;
    provideRecordPopup(() => called++);
    stale();
    expect(openRecordPopup('t-1', 'r-1')).toBe(true);
    expect(called).toBe(1);
  });

  it('lets the last writer win', () => {
    const seen: string[] = [];
    provideRecordPopup(() => seen.push('first'));
    provideRecordPopup(() => seen.push('second'));
    openRecordPopup('t-1', 'r-1');
    expect(seen).toEqual(['second']);
  });
});
