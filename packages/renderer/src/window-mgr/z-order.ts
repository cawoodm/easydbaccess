/**
 * Pure ascending-z ordering used by the global restack (`restack.ts`). Kept
 * free of DOM/store dependencies so it's directly unit-testable — see
 * `z-order.test.ts`.
 */
export interface ZOrderCandidate {
  id: string;
  /** windowGeometry.z — undefined (never fronted) sorts as oldest. */
  z: number | undefined;
  minimized: boolean;
}

/**
 * Ascending-z order across a merged list of table + view candidates, with
 * minimized entries excluded — a minimized window must never be forced to the
 * front. Ties (equal or missing z) keep the input's relative order (Array#sort
 * is stable in all supported engines).
 */
export function orderForRestack(candidates: ZOrderCandidate[]): string[] {
  return candidates
    .filter((c) => !c.minimized)
    .slice()
    .sort((a, b) => (a.z ?? -Infinity) - (b.z ?? -Infinity))
    .map((c) => c.id);
}
