import type { WindowGeometry } from '@easydb/shared';

/** Minimum sensible panel dimensions; anything smaller is treated as corrupt. */
export const MIN_W = 200;
export const MIN_H = 100;

/**
 * Validates persisted geometry, discarding only corrupt records.
 *
 * Returns null (→ caller falls back to defaults: cascade + 720x360) when `g`
 * is missing, has a non-finite field, or is smaller than the minimum sensible
 * size. Otherwise the geometry is returned verbatim — position is NOT clamped:
 * a panel may legitimately restore partly or fully off-screen, because the
 * pan/zoom canvas (touch pan / desktop right-drag) brings it back into view.
 */
export function sanitizeGeometry(g: WindowGeometry | undefined): WindowGeometry | null {
  if (!g) return null;
  if (!Number.isFinite(g.w) || !Number.isFinite(g.h)) return null;
  if (!Number.isFinite(g.x) || !Number.isFinite(g.y)) return null;
  if (g.w < MIN_W || g.h < MIN_H) return null;
  return { ...g };
}

/**
 * Ascending order by `windowGeometry.z` (undefined ⇒ oldest/bottom). Shared by
 * the table AND view window managers so each one's own boot-open loop
 * reproduces its saved per-kind order. This only orders WITHIN one kind's
 * opening sequence — the cross-kind merge that fixes relative table/view
 * stacking is `z-order.ts` + `restack.ts`.
 */
export function byAscendingZ(
  a: { windowGeometry?: WindowGeometry | undefined },
  b: { windowGeometry?: WindowGeometry | undefined },
): number {
  return (a.windowGeometry?.z ?? -Infinity) - (b.windowGeometry?.z ?? -Infinity);
}
