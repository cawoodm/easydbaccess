// packages/renderer/src/table/refresh-merge.ts
//
// Merge freshly-fetched remote rows with the user's current local rows when a
// "copy" (snapshot) table is refreshed. Pure and DOM-free so it's unit-testable.
//
// The rule that matters: a refresh must overwrite anything that came from the
// remote source (values change, columns disappear) while preserving anything
// the user layered on top locally — most notably user-added columns (e.g. a
// manual "read" boolean) — matched row-for-row by primary key so the right
// user value lands on the right row even if remote row order shifted.
//
//   • strip(row): user-deleted remote fields (`deletedRemoteFields`) never
//     persist, on either the old or the fresh side.
//   • if there's no reliable way to match old rows to fresh rows — no `pks`,
//     or a fresh row is missing a pk value — fall back to fresh-only output:
//     no user-added-column carryover, `merged: false`.
//   • otherwise, match by pk (first old row wins on a duplicate key) and, for
//     each fresh row (in fresh order), copy over any `userAddedFields` the
//     matched old row owns. A fresh row with no old match (a row the user had
//     deleted locally, now reappearing) is restored with no user columns to
//     carry over, since there is nothing local to carry.

export interface RefreshMergeInput {
  /** Current local row data blobs (may carry user-added-column values + edits). */
  oldRows: Array<{ data: Record<string, unknown> }>;
  /** Freshly fetched remote row data blobs (contain remote columns only). */
  freshRows: Array<Record<string, unknown>>;
  /** Primary-key column field names used to match old<->fresh rows. */
  pks: string[];
  /** Field names the user added locally (not part of the remote schema). Their values are carried over from the matched old row. */
  userAddedFields: string[];
  /** Remote field names the user deleted; their values must NOT appear in the output. */
  deletedRemoteFields?: string[];
}

export interface RefreshMergeResult {
  /** Merged row data blobs, one per fresh remote row, in fresh order. */
  data: Array<Record<string, unknown>>;
  /** True if a pk-based merge ran; false if it fell back (no pks) to fresh-only. */
  merged: boolean;
}

function keyOf(data: Record<string, unknown>, pks: string[]): string {
  return JSON.stringify(pks.map((k) => data[k]));
}

function hasAllPkValues(data: Record<string, unknown>, pks: string[]): boolean {
  return pks.every((k) => data[k] !== null && data[k] !== undefined);
}

export function mergeRefreshedRows(input: RefreshMergeInput): RefreshMergeResult {
  const { oldRows, freshRows, pks, userAddedFields, deletedRemoteFields = [] } = input;
  const deletedSet = new Set(deletedRemoteFields);

  const strip = (row: Record<string, unknown>): Record<string, unknown> => {
    const out: Record<string, unknown> = { ...row };
    for (const field of deletedSet) {
      delete out[field];
    }
    return out;
  };

  const canMerge = pks.length > 0 && freshRows.every((row) => hasAllPkValues(row, pks));
  if (!canMerge) {
    return { data: freshRows.map(strip), merged: false };
  }

  const oldByKey = new Map<string, { data: Record<string, unknown> }>();
  for (const oldRow of oldRows) {
    const key = keyOf(oldRow.data, pks);
    if (!oldByKey.has(key)) {
      oldByKey.set(key, oldRow);
    }
  }

  const data = freshRows.map((freshRow) => {
    const out = strip(freshRow);
    const key = keyOf(freshRow, pks);
    const oldRow = oldByKey.get(key);
    if (oldRow) {
      for (const field of userAddedFields) {
        if (Object.prototype.hasOwnProperty.call(oldRow.data, field)) {
          out[field] = oldRow.data[field];
        }
      }
    }
    return out;
  });

  return { data, merged: true };
}
