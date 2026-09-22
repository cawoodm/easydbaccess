// packages/renderer/src/window-mgr/child-plan.ts
//
// What it takes to turn one list of children into another, moving as little as
// possible.
//
// This is not an optimisation. Moving a node in the DOM is a REMOVE followed by
// an insert, and a removal fires `disconnectedCallback` on every custom element
// in the subtree — including a docked visualization, which destroys its Leaflet
// or Chart.js instance there. So `panel-stack.ts` rebuilding its rows by
// re-appending every pane blanked every chart and map on that edge, and only a
// reload brought them back.
//
// Pure and generic over the node type, so the decision can be checked without a
// DOM (there is no jsdom in this repo's vitest setup, by choice).

export interface ChildPlan<T> {
  /** Children that are not in the wanted list. Remove these first. */
  drop: T[];
  /**
   * Insertions to apply IN ORDER, each as `insertBefore(node, before)` with
   * `before === null` meaning append. A node already in the right place never
   * appears here — that is the whole point.
   */
  insert: { node: T; before: T | null }[];
}

/**
 * How to make `current` read as `wanted`.
 *
 * Drops come first so that a list which merely SHRANK needs no insertions at
 * all: removing the first row of two leaves the second one already at index 0,
 * where re-inserting it would have torn its panes down for nothing.
 */
export function planChildren<T>(current: readonly T[], wanted: readonly T[]): ChildPlan<T> {
  const keep = new Set<T>(wanted);
  const drop = current.filter((n) => !keep.has(n));
  // The list as it will stand once the drops are applied, kept in step with the
  // insertions below so each one can name the node it lands before.
  const list = current.filter((n) => keep.has(n));
  const insert: { node: T; before: T | null }[] = [];
  wanted.forEach((node, i) => {
    if (list[i] === node) return;
    const at = list.indexOf(node);
    if (at >= 0) list.splice(at, 1);
    list.splice(i, 0, node);
    insert.push({ node, before: list[i + 1] ?? null });
  });
  return { drop, insert };
}

/** Apply a plan to a real parent element. */
export function applyChildPlan(parent: Element, plan: ChildPlan<Element>): void {
  for (const node of plan.drop) node.remove();
  for (const { node, before } of plan.insert) parent.insertBefore(node, before);
}
