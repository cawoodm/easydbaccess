// packages/renderer/src/table/visible-rows.ts
//
// "Here are the rows currently on screen." Published by the grid, consumed by
// anything drawing a picture of the same data.
//
// It exists because a docked visualization has to agree with the grid beside it.
// The grid already narrows rows three ways — per-column filters, its own search
// box, and the app-wide header search — and re-deriving that in a second place
// would mean two code paths obliged to keep giving the same answer. Worse, it
// would mean a second FETCH of a table the grid has already read, which is the
// cost `shared/src/row-query.ts` documents: 1483ms and 15.4MB to show about 30
// rows. So the grid publishes and the pane listens.
//
// **A plain registry, deliberately, not a `document` CustomEvent.** The sibling
// `easydb:visible-count` (`window-mgr/panel-title.ts`) and
// `db/settings-events.ts` both use document events, and for good reason: their
// consumers are unknown to the producer, and a settings write can come from code
// that would never import a registry. Neither applies here, and two things argue
// the other way:
//
//  - **Publishing has to be conditional.** The payload is the whole filtered row
//    set, so emitting per render for nobody would copy an array on every
//    keystroke in a filter box. A registry answers "is anyone listening?" for
//    free; with a document event that has to be bolted on beside it.
//  - **A registry is testable in Node.** This repo's vitest runs with no DOM at
//    all (see `docs/tech/TESTING.md`), so a `document`-dependent module can only
//    ever be exercised by Playwright. The bookkeeping here is the part with rules
//    in it, and it deserves unit tests.
//
// A windowed visualization has no grid to listen to and reads rows itself
// instead — see `viz/viz-panel.ts`.

import type { Row } from '@easydb/shared';

export interface VisibleRowsDetail {
  /** View-instance id in view-bound mode, else the table id. Same key as `easydb:visible-count`. */
  key: string;
  /** The rows on screen, after filters, search and sort. */
  rows: readonly Row[];
  /** What the read matched before any cap — a floor when `truncated`. */
  total: number;
  /** The read stopped short, so `rows` is a prefix of the answer. */
  truncated: boolean;
  /** Is a free-text search part of what produced this set? */
  searching: boolean;
}

export type VisibleRowsListener = (detail: VisibleRowsDetail) => void;

const listeners = new Map<string, Set<VisibleRowsListener>>();

/**
 * Say that something wants this key's rows. Returns the release function; call it
 * on disconnect or the grid keeps building payloads for a pane that is gone.
 */
export function watchVisibleRows(key: string, fn: VisibleRowsListener): () => void {
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
 * Providers that can produce the current set on demand, keyed the same way.
 *
 * Push alone is not enough. A pane mounts AFTER the grid has rendered, and the
 * grid only publishes when somebody is already listening — so the first publish a
 * new pane could possibly hear is the next time the grid re-renders, which for a
 * table nobody is touching never comes. The pane sat empty saying "No data" beside
 * a full grid.
 *
 * So: push for updates, PULL for the initial value.
 */
const providers = new Map<string, () => VisibleRowsDetail | null>();

/** The grid registers itself here so a late listener can pull. */
export function provideVisibleRows(key: string, fn: () => VisibleRowsDetail | null): () => void {
  providers.set(key, fn);
  return () => {
    if (providers.get(key) === fn) providers.delete(key);
  };
}

/**
 * Ask for this key's rows now, rather than waiting to be told.
 *
 * Returns null when no grid is mounted for the key — a windowed visualization, or
 * a host that is minimized. That is a real answer, not a failure: the caller reads
 * the store itself in the first case and has nothing to draw in the second.
 */
export function requestVisibleRows(key: string): VisibleRowsDetail | null {
  try {
    return providers.get(key)?.() ?? null;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[visible-rows] provider failed', err);
    return null;
  }
}

/** Is anything listening for this key? The grid's guard before building a payload. */
export function visibleRowsWanted(key: string): boolean {
  return (listeners.get(key)?.size ?? 0) > 0;
}

/**
 * Publish the current row set. A no-op when nothing is listening.
 *
 * A listener that throws must not take the grid's render pass down with it — a
 * broken third-party visualization is a broken picture, not a broken table.
 */
export function emitVisibleRows(detail: VisibleRowsDetail): void {
  const set = listeners.get(detail.key);
  if (!set || set.size === 0) return;
  // Snapshot: a listener may release itself (or another) while being called.
  for (const fn of [...set]) {
    try {
      fn(detail);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[visible-rows] listener failed', err);
    }
  }
}

/** Test seam: forget every registration. */
export function __resetVisibleRowsWatchers(): void {
  listeners.clear();
  providers.clear();
}
