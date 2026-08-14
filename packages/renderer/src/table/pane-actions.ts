// packages/renderer/src/table/pane-actions.ts
//
// "Change what you are showing." A docked pane asking its HOST grid to filter
// or sort — the mirror image of `visible-rows.ts`, and deliberately its twin.
//
// A visualization is a two-way street: it is always drawn from the data in the
// grid, and when it is docked into that grid's window it may change it back.
// The outward half has existed since visualizations landed (`visible-rows.ts`:
// the grid publishes its filtered set, the pane never reads the store). This is
// the half that did not, and without it no visualization can do anything but be
// looked at — a bar is not clickable, a map marker selects nothing, a word in a
// cloud does not filter.
//
// **A seam, not a feature.** It is here rather than inside whichever
// visualization needed it first because every kind is a potential caller: once
// the grid can be asked, making a bar click filter is a few lines in the chart
// element. An API built one-way for one caller has to be redesigned the moment
// the second appears.
//
// Keyed exactly as `visible-rows.ts` is — the view-instance id in view-bound
// mode, else the table id — so the pair reads as one contract with a direction
// each way, and a pane that can read a host can always write to it.
//
// A plain registry rather than a `document` event, for the reasons
// `visible-rows.ts` sets out: the consumer is known to the producer, and the
// bookkeeping deserves unit tests that run without a DOM.

/** What a grid offers a pane docked into it. */
export interface PaneActionHost {
  /**
   * Narrow the grid on one column. `value` is a plain value, not filter syntax:
   * the host composes it into whatever it already has, so two pills on the same
   * column OR together rather than one replacing the other.
   */
  filter(field: string, value: string): void;
  /**
   * Sort the grid by one column. `additive` adds a sort level (the shift-click
   * of a header) instead of replacing the sort.
   */
  sort(field: string, additive: boolean): void;
}

const hosts = new Map<string, PaneActionHost>();

/** A grid offering itself as the host for `key`. Returns the release function. */
export function providePaneActions(key: string, host: PaneActionHost): () => void {
  hosts.set(key, host);
  return () => {
    if (hosts.get(key) === host) hosts.delete(key);
  };
}

/**
 * Ask the host for `key` to narrow itself.
 *
 * Returns false when there is no host — a windowed visualization, or a pane
 * whose host is minimized. That is an answer, not a failure: the caller then
 * filters its own rows instead, which is what a view does.
 */
export function paneFilter(key: string, field: string, value: string): boolean {
  return run(key, (host) => host.filter(field, value));
}

/** Ask the host for `key` to sort itself. Same contract as `paneFilter`. */
export function paneSort(key: string, field: string, additive = false): boolean {
  return run(key, (host) => host.sort(field, additive));
}

/** Is anything listening for `key`? Lets a pane hide a control it cannot honour. */
export function paneActionsAvailable(key: string): boolean {
  return hosts.has(key);
}

function run(key: string, fn: (host: PaneActionHost) => void): boolean {
  const host = key ? hosts.get(key) : undefined;
  if (!host) return false;
  try {
    fn(host);
    return true;
  } catch (err) {
    // A host that throws must not take the pane's click handler down with it —
    // the same guard `emitVisibleRows` puts around a listener.
    // eslint-disable-next-line no-console
    console.warn('[pane-actions] host failed', err);
    return false;
  }
}

/** Test seam: forget every registration. */
export function __resetPaneActions(): void {
  hosts.clear();
}
