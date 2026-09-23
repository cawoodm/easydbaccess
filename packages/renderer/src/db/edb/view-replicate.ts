// packages/renderer/src/db/edb/view-replicate.ts
//
// The rules for carrying `ViewTemplate`s and `ViewInstance`s across a merge —
// pure, so a Node-only Vitest run can check them the same way
// `active-file-sync.ts`'s header argues for splitting THAT rule out of
// `folder-sync.ts`: everything around a real merge needs a live workspace, a
// worker and the OPFS pool, none of which exist in a test run, but the RULE
// itself needs none of that.
//
// `replicate.ts`'s `diffRows` / `planRows` already answer "which of two
// stamped things wins" for a table's rows, and a view document is exactly
// that shape — `{id, updatedAt}` — so `replicate-run.ts` reuses them as-is for
// `viewTemplates` and `viewInstances` rather than this module reimplementing
// the same diff. What THIS module owns is the one thing rows never needed: a
// view instance points at a TABLE by id, and the two sides of a merge don't
// agree on ids — see `tableIdMap` and `remapInstance` below.

import type { TableDiff, ViewInstance } from '@easydb/shared';

/**
 * Table id on `here` ↔ table id on `disk`, for every table the two sides
 * agree is the SAME table.
 *
 * Built only from `TableDiff`s that carry both `here` and `disk` — `diffTables`
 * pairs a table by id first and then by NAME, so a table that was deleted and
 * re-imported (the ordinary refresh loop for anything backed by a URL or a
 * Datasette instance) is matched by name but carries a different id on each
 * side. A `ViewInstance.tableId` from one side is meaningless on the other
 * without this map.
 */
export function tableIdMap(diffs: readonly TableDiff[]): { hereToDisk: Map<string, string>; diskToHere: Map<string, string> } {
  const hereToDisk = new Map<string, string>();
  const diskToHere = new Map<string, string>();
  for (const d of diffs) {
    if (!d.here || !d.disk) continue;
    hereToDisk.set(d.here.id, d.disk.id);
    diskToHere.set(d.disk.id, d.here.id);
  }
  return { hereToDisk, diskToHere };
}

/**
 * Carry one view instance from one side of a merge to the other, or say it
 * cannot go.
 *
 * `idMap` is `tableIdMap`'s map in the DIRECTION this instance is travelling —
 * `diskToHere` when pulling, `hereToDisk` when pushing. An id absent from the
 * map is not an error: it means the two sides use the same id for that table
 * (the ordinary case, no rename or re-import involved), so the id passes
 * through unchanged.
 */
export function remapInstance(inst: ViewInstance, idMap: ReadonlyMap<string, string>, workspaceId: string, tablesOnTarget: ReadonlySet<string>): ViewInstance | null {
  const tableId = idMap.get(inst.tableId) ?? inst.tableId;
  // A view of a table the target side does not have has nothing to draw from.
  // `ViewInstance.tableName` is what lets `view-window-manager.ts` reconnect it
  // to a same-named table later, so dropping it here loses nothing that isn't
  // already unrecoverable — only what is genuinely unbindable is dropped.
  if (!tablesOnTarget.has(tableId)) return null;

  let dock = inst.dock;
  if (dock && dock.host.kind === 'table') {
    const hostTableId = idMap.get(dock.host.tableId) ?? dock.host.tableId;
    // Mirrors `remapDock` in `plugins/json-import.ts`: a dock whose HOST table
    // does not exist on the target side cannot be mounted, but the chart itself
    // still can be — so the dock is dropped and the instance opens in its own
    // window instead. Visible in the wrong place beats invisible.
    dock = tablesOnTarget.has(hostTableId) ? { ...dock, host: { kind: 'table', tableId: hostTableId } } : undefined;
  }
  // A `view` host needs no remap at all: view-instance ids are carried across
  // merges unchanged (only table ids are re-minted on either side), so a dock
  // onto another view instance stays valid as written.

  return { ...inst, tableId, workspaceId, dock };
}
