// packages/renderer/src/table/current-row.ts
//
// "Which row is the user looking at." The twin of `visible-rows.ts`, and
// deliberately its mirror image in every respect.
//
// `visible-rows.ts` publishes the grid's filtered set, plural, which is what a
// chart or a map draws. A RECORD pane draws one row, so it needs a selection —
// and until this module there was no such thing anywhere in the app. The grid
// has a hover state and a cell-edit focus, neither of which survives leaving the
// cell, and neither of which anything outside the grid can read.
//
// **Selecting is not filtering.** `table/pane-actions.ts` already lets a docked
// pane narrow its host, so a record pane could have read `rows[0]` and a
// double-click could have filtered the grid down to that one record. It would
// have needed no new module at all — and it would throw away the filter the user
// was working in every time they looked at a row. The two are different
// questions and they get different channels.
//
// **A plain registry, not a `document` CustomEvent**, for the reasons
// `visible-rows.ts` sets out at length and which all apply here: the consumer is
// known to the producer, publishing should be conditional on somebody listening,
// and a registry is testable in a repo whose vitest run has no DOM.
//
// Keyed exactly as `visible-rows.ts` and `pane-actions.ts` are — the
// view-instance id in view-bound mode, else the table id — so a pane that can
// read a host's rows can always read its selection too.

/** Called with the newly selected row id, or null when the selection was cleared. */
export type CurrentRowListener = (rowId: string | null) => void;

const listeners = new Map<string, Set<CurrentRowListener>>();
const providers = new Map<string, () => string | null>();

/** The selection this key is holding, per whoever last set it. */
const current = new Map<string, string | null>();

/**
 * Follow this key's selection. Returns the release function.
 *
 * Also the answer to "does anything care about the selection here?" — see
 * {@link currentRowWanted}, which is what lets the grid's double-click mean two
 * different things without either handler knowing about the other.
 */
export function watchCurrentRow(key: string, fn: CurrentRowListener): () => void {
  let set = listeners.get(key);
  if (!set) {
    set = new Set();
    listeners.set(key, set);
  }
  set.add(fn);
  return () => {
    const cur = listeners.get(key);
    if (!cur) return;
    cur.delete(fn);
    if (cur.size === 0) listeners.delete(key);
  };
}

/**
 * Is anything following this key's selection?
 *
 * Two callers read it and they are the whole reason it exists. `viz-record` sets
 * the selection on a row double-click; `edit-record` opens the record FORM on
 * the same gesture and stands down when this is true. Exactly one of them acts,
 * and neither imports the other.
 */
export function currentRowWanted(key: string): boolean {
  return (listeners.get(key)?.size ?? 0) > 0;
}

/**
 * Select a row. A no-op when nothing is following this key.
 *
 * The value is remembered whether or not anyone is listening, so a pane that
 * mounts afterwards can pull it — the same push-for-updates, pull-for-the-first
 * -value arrangement `visible-rows.ts` needs and for the same reason: a pane
 * mounts after the grid, and an event it was not there to hear is lost.
 */
export function setCurrentRow(key: string, rowId: string | null): void {
  if (!key) return;
  if (current.get(key) === rowId) return;
  current.set(key, rowId);
  const set = listeners.get(key);
  if (!set || set.size === 0) return;
  // Snapshot: a listener may release itself (or another) while being called.
  for (const fn of [...set]) {
    try {
      fn(rowId);
    } catch (err) {
      // A broken pane is a broken picture, not a broken grid — the same guard
      // `emitVisibleRows` puts around a listener.
      // eslint-disable-next-line no-console
      console.warn('[current-row] listener failed', err);
    }
  }
}

/**
 * The selection for this key, or null.
 *
 * **A registered provider's answer WINS, null included.** The grid is the only
 * thing that can say whether the remembered row is still on screen, so its null
 * is a veto — the row was deleted, or filtered away — and falling back to the
 * remembered id there would hand a pane a record the grid is not showing, which
 * is the one thing the provider exists to prevent.
 *
 * The remembered value is for the case with NO provider: a key whose grid is
 * minimized or not mounted yet, where the last selection is the best answer
 * available. A provider that throws counts as absent rather than as a veto — a
 * transient failure should not clear a selection.
 */
export function requestCurrentRow(key: string): string | null {
  const provider = providers.get(key);
  if (provider) {
    try {
      return provider();
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[current-row] provider failed', err);
    }
  }
  return current.get(key) ?? null;
}

/**
 * What was last SET for this key, with no provider consulted.
 *
 * The grid's own provider reads it — to answer "is that row still here?" it has
 * to know which row was asked about, and going through {@link requestCurrentRow}
 * would call the provider it is inside.
 */
export function rememberedCurrentRow(key: string): string | null {
  return current.get(key) ?? null;
}

/**
 * The grid offers a verdict on the remembered id — is that row still here?
 *
 * Without it a selection outlives its row: delete the selected record, or filter
 * it off screen, and the pane goes on drawing a row the grid no longer has. The
 * provider answers null in that case and the pane falls back to the first
 * visible row, which is what "no selection" means everywhere else here.
 */
export function provideCurrentRow(key: string, fn: () => string | null): () => void {
  providers.set(key, fn);
  return () => {
    if (providers.get(key) === fn) providers.delete(key);
  };
}

/** Forget a key's selection — the grid on disconnect, so a reopened window starts clean. */
export function clearCurrentRow(key: string): void {
  current.delete(key);
}

/** Test seam: forget every registration and every selection. */
export function __resetCurrentRow(): void {
  listeners.clear();
  providers.clear();
  current.clear();
}
