/**
 * Cross-kind window restack: fronts panels — table AND view windows together —
 * in one merged ascending-z order.
 *
 * Table windows and view windows are opened by two independent managers
 * (`jspanel-manager.ts`, `view-window-manager.ts`), each via its own liveQuery
 * subscription. Sorting tables among themselves (or views among themselves)
 * cannot restore "windows as they were" — the relative order between a table
 * and a view is decided by whichever manager's subscription happens to create
 * its panel last, not by the saved z. This module is the one place both kinds
 * are merged and re-fronted together.
 *
 * Originally this only ran after a bulk gist/server-sync pull (which inserts
 * tables one at a time and defeats the boot sort — see the dispatch sites in
 * `gist-sync.ts` / `json-import.ts`). The exact same problem exists at plain
 * boot: `table-list.ts` calls `initWindowManager()` (opens all tables) before
 * `initViewWindowManager()` (opens all views), so a view's panel is ALWAYS
 * created after every table's panel — regardless of which was actually
 * fronted last before the reload. `initRestack()` therefore also runs one pass
 * right after both managers finish their initial open.
 */
import { getContext } from '../app-context.js';
import { FORCE_MINIMIZED } from './boot-flags.js';
import { hasPanel, frontPanel } from './panel-registry.js';
import { orderForRestack, type ZOrderCandidate } from './z-order.js';

let listenerWired = false;

/** Wire the `easydb:restack-windows` listener once (idempotent), then run one
 * pass immediately — the boot-settle restack. */
export async function initRestack(): Promise<void> {
  if (!listenerWired) {
    listenerWired = true;
    document.addEventListener('easydb:restack-windows', () => void restackAll());
  }
  await restackAll();
}

/**
 * Re-front every open, non-minimized panel (table or view) in ascending
 * saved-z order. Panels open asynchronously (liveQuery), so retry until every
 * expected panel is registered — mirrors the retry loop this replaces in
 * `jspanel-manager.ts`.
 */
export async function restackAll(): Promise<void> {
  // Nothing to re-front under `?minimize`: every panel was opened minimized,
  // and `frontPanel` would un-park them, defeating the flag. The `minimized`
  // filter below cannot catch this — it reads the STORED geometry, which
  // `?minimize` deliberately leaves untouched so a plain reload restores the
  // user's real layout. So the flag has to be asked directly, here, where it
  // also covers the `easydb:restack-windows` listener (a gist pull or a dump
  // import can fire it long after boot).
  if (FORCE_MINIMIZED) return;

  const ctx = await getContext();
  for (let attempts = 0; attempts <= 12; attempts++) {
    const [tables, views] = await Promise.all([
      ctx.store.tables.find(),
      ctx.store.viewInstances.find(),
    ]);
    const candidates: ZOrderCandidate[] = [
      ...tables
        .filter((t) => t.workspaceId === ctx.workspaceId && !t.windowGeometry?.closed)
        .map((t) => ({
          id: t.id,
          z: t.windowGeometry?.z,
          minimized: t.windowGeometry?.minimized === true,
        })),
      ...views
        .filter((v) => v.workspaceId === ctx.workspaceId && v.open)
        .map((v) => ({
          id: v.id,
          z: v.windowGeometry?.z,
          minimized: v.windowGeometry?.minimized === true,
        })),
    ];
    const ordered = orderForRestack(candidates);
    if (attempts < 12 && !ordered.every((id) => hasPanel(id))) {
      await new Promise<void>((resolve) => setTimeout(resolve, 80));
      continue;
    }
    for (const id of ordered) frontPanel(id);
    return;
  }
}
