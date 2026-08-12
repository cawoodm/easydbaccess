/**
 * When to write the file.
 *
 * The rule that matters: a batch saves ONCE. Importing 600k rows is 600k writes
 * through the bridge, and a naive "save on every change" would try to serialise
 * and write the whole database that many times. So a batch is opened, changes
 * accumulate, and the save happens when it closes.
 *
 * Pure timing logic with an injected clock and scheduler, so the policy is
 * testable without a DOM or a real database.
 */

export interface AutosavePolicyOptions {
  /** Performs the actual save. Rejections are reported, never thrown at the caller. */
  save: () => Promise<void>;
  /** Quiet period after a manual change before saving. */
  debounceMs?: number;
  /** Scheduler, injected so tests can drive it. */
  setTimer?: (fn: () => void, ms: number) => number;
  clearTimer?: (handle: number) => void;
  /** Told when a save fails, so the UI can say so rather than looking clean. */
  onError?: (err: unknown) => void;
}

export interface AutosavePolicy {
  /** Autosave is off by default: a user who never pressed Save has not chosen a file. */
  setEnabled(on: boolean): void;
  enabled(): boolean;
  /** A change happened. Saves later, or not at all while a batch is open. */
  changed(): void;
  /** Open a batch — an import, a bulk delete. Nested calls are counted. */
  beginBatch(): void;
  /** Close a batch. The save happens when the last one closes, and only if something changed. */
  endBatch(): void;
  /** Is there anything unsaved? */
  isDirty(): boolean;
  /** Mark everything saved — what a successful manual Save reports. */
  markClean(): void;
  /** Drop any pending timer. */
  dispose(): void;
}

export function createAutosavePolicy(opts: AutosavePolicyOptions): AutosavePolicy {
  const debounceMs = opts.debounceMs ?? 1000;
  const setTimer = opts.setTimer ?? ((fn, ms) => globalThis.setTimeout(fn, ms) as unknown as number);
  const clearTimer = opts.clearTimer ?? ((h) => globalThis.clearTimeout(h));

  let on = false;
  let dirty = false;
  let depth = 0;
  let timer: number | null = null;
  // A save is async; a change arriving mid-save must not be lost, so the dirty
  // flag is cleared BEFORE the write and restored if the write fails.
  let saving = false;

  function cancel(): void {
    if (timer !== null) {
      clearTimer(timer);
      timer = null;
    }
  }

  function runSave(): void {
    cancel();
    if (!dirty || saving) return;
    saving = true;
    dirty = false;
    void opts
      .save()
      .catch((err: unknown) => {
        // Nothing was written, so the workspace is still unsaved. Saying it is
        // clean would be a lie the user pays for later.
        dirty = true;
        opts.onError?.(err);
      })
      .finally(() => {
        saving = false;
      });
  }

  function schedule(): void {
    if (!on || depth > 0) return;
    cancel();
    timer = setTimer(runSave, debounceMs);
  }

  return {
    setEnabled(next: boolean): void {
      on = next;
      if (!on) cancel();
      else schedule();
    },
    enabled: () => on,
    changed(): void {
      dirty = true;
      schedule();
    },
    beginBatch(): void {
      depth++;
      // Nothing is written while a batch runs, so a timer armed before it started
      // must not fire mid-import.
      cancel();
    },
    endBatch(): void {
      depth = Math.max(0, depth - 1);
      if (depth === 0) schedule();
    },
    isDirty: () => dirty,
    markClean(): void {
      dirty = false;
      cancel();
    },
    dispose: cancel,
  };
}
