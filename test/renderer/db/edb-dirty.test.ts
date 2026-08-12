import { describe, expect, it, vi } from 'vitest';
import { createAutosavePolicy } from '../../../packages/renderer/src/db/edb/dirty.js';

/**
 * The autosave policy, with the clock in the test's hands.
 *
 * The case that drove this code: importing 600k rows is 600k changes, and a
 * policy that saved on each one would serialise and write the whole database
 * 600k times. A batch must collapse to one save.
 */

function harness(over: { debounceMs?: number } = {}) {
  const timers = new Map<number, () => void>();
  let nextHandle = 1;
  const save = vi.fn(() => Promise.resolve());
  const onError = vi.fn();
  const policy = createAutosavePolicy({
    save,
    onError,
    debounceMs: over.debounceMs ?? 1000,
    setTimer: (fn) => {
      const h = nextHandle++;
      timers.set(h, fn);
      return h;
    },
    clearTimer: (h) => void timers.delete(h),
  });
  /** Fire every armed timer, as the clock reaching the debounce would. */
  const tick = () => {
    const armed = [...timers.values()];
    timers.clear();
    for (const fn of armed) fn();
  };
  return { policy, save, onError, tick, pending: () => timers.size };
}

describe('autosave', () => {
  it('is off until switched on, so a workspace with no file is never written', () => {
    const { policy, save, tick } = harness();
    expect(policy.enabled()).toBe(false);
    policy.changed();
    tick();
    expect(save).not.toHaveBeenCalled();
  });

  it('saves once after a change, when the quiet period elapses', () => {
    const { policy, save, tick } = harness();
    policy.setEnabled(true);
    policy.changed();
    expect(save).not.toHaveBeenCalled(); // not immediately
    tick();
    expect(save).toHaveBeenCalledOnce();
  });

  it('collapses a burst of changes into one save', () => {
    const { policy, save, tick } = harness();
    policy.setEnabled(true);
    for (let i = 0; i < 50; i++) policy.changed();
    tick();
    expect(save).toHaveBeenCalledOnce();
  });

  it('saves once for a whole batch, not once per change inside it', () => {
    const { policy, save, tick } = harness();
    policy.setEnabled(true);
    policy.beginBatch();
    for (let i = 0; i < 1000; i++) policy.changed();
    tick(); // the clock runs during the import — nothing may be written yet
    expect(save).not.toHaveBeenCalled();
    policy.endBatch();
    tick();
    expect(save).toHaveBeenCalledOnce();
  });

  it('waits for the outermost batch to close when batches nest', () => {
    const { policy, save, tick } = harness();
    policy.setEnabled(true);
    policy.beginBatch();
    policy.beginBatch();
    policy.changed();
    policy.endBatch();
    tick();
    expect(save).not.toHaveBeenCalled();
    policy.endBatch();
    tick();
    expect(save).toHaveBeenCalledOnce();
  });

  it('does not save a batch that changed nothing', () => {
    const { policy, save, tick } = harness();
    policy.setEnabled(true);
    policy.beginBatch();
    policy.endBatch();
    tick();
    expect(save).not.toHaveBeenCalled();
  });

  it('does not save when nothing is dirty', () => {
    const { policy, save, tick } = harness();
    policy.setEnabled(true);
    tick();
    expect(save).not.toHaveBeenCalled();
  });

  it('reports dirty until a save happens, and clean after', async () => {
    const { policy, tick } = harness();
    policy.setEnabled(true);
    policy.changed();
    expect(policy.isDirty()).toBe(true);
    tick();
    await Promise.resolve();
    expect(policy.isDirty()).toBe(false);
  });

  it('stays dirty when the save fails, rather than claiming to be saved', async () => {
    const timers = new Map<number, () => void>();
    let h = 1;
    const policy = createAutosavePolicy({
      save: () => Promise.reject(new Error('permission withdrawn')),
      debounceMs: 1,
      setTimer: (fn) => {
        const key = h++;
        timers.set(key, fn);
        return key;
      },
      clearTimer: (key) => void timers.delete(key),
    });
    policy.setEnabled(true);
    policy.changed();
    for (const fn of [...timers.values()]) fn();
    await Promise.resolve();
    await Promise.resolve();
    expect(policy.isDirty()).toBe(true);
  });

  it('reports a failed save to the caller so the UI can say so', async () => {
    const timers = new Map<number, () => void>();
    let h = 1;
    const onError = vi.fn();
    const policy = createAutosavePolicy({
      save: () => Promise.reject(new Error('disk full')),
      onError,
      setTimer: (fn) => {
        const key = h++;
        timers.set(key, fn);
        return key;
      },
      clearTimer: (key) => void timers.delete(key),
    });
    policy.setEnabled(true);
    policy.changed();
    for (const fn of [...timers.values()]) fn();
    await Promise.resolve();
    await Promise.resolve();
    expect(onError).toHaveBeenCalledOnce();
  });

  it('markClean drops a pending save — a manual Save just wrote everything', () => {
    const { policy, save, tick } = harness();
    policy.setEnabled(true);
    policy.changed();
    policy.markClean();
    tick();
    expect(save).not.toHaveBeenCalled();
    expect(policy.isDirty()).toBe(false);
  });

  it('disarms its timer when switched off mid-wait', () => {
    const { policy, save, tick } = harness();
    policy.setEnabled(true);
    policy.changed();
    policy.setEnabled(false);
    tick();
    expect(save).not.toHaveBeenCalled();
  });
});
