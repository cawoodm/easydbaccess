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
//   • match by PK when the origin recorded one and every fresh row has a value
//     for it. Best case: a row is recognised even when its remote values have
//     changed.
//   • otherwise match by CONTENT — the tuple of the row's remote field values.
//     A row with those values IS that row, so this handles reordering, and it
//     can never mis-attribute the way positional matching would. Its limit is
//     honest and reported: a row whose REMOTE value changed cannot be
//     recognised, so its local values are dropped and counted in
//     `droppedUserRows`.
//
//     This path exists because most snapshots have no primary key at all — CSV
//     and JSON imports never record one, and neither does a Datasette VIEW.
//     Before it, every one of those refreshes silently threw away the columns
//     the user had added and filled in, which is the whole point of keeping a
//     local snapshot rather than a live connection.
//   • either way, for each fresh row (in fresh order), copy over any
//     `userAddedFields` the matched old row owns; first old row wins on a
//     duplicate key. A fresh row with no old match (a row the user had deleted
//     locally, now reappearing) is restored with no user columns to carry.

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

/** How old rows were matched to fresh ones. */
export type MergeStrategy = 'pk' | 'content' | 'none';

export interface RefreshMergeResult {
  /** Merged row data blobs, one per fresh remote row, in fresh order. */
  data: Array<Record<string, unknown>>;
  /** True when rows were MATCHED (by pk or by content) rather than replaced. */
  merged: boolean;
  /** Which rule did the matching — worth telling the user, they differ in strength. */
  strategy: MergeStrategy;
  /**
   * Old rows that held a user-added value but matched nothing fresh, so that
   * value is now gone. Never silently zero: the caller surfaces it.
   */
  droppedUserRows: number;
}

/** A row's identity under whichever field set is doing the matching. */
function keyOf(data: Record<string, unknown>, fields: string[]): string {
  return JSON.stringify(fields.map((k) => data[k] ?? null));
}

function hasAllPkValues(data: Record<string, unknown>, pks: string[]): boolean {
  return pks.every((k) => data[k] !== null && data[k] !== undefined);
}

export function mergeRefreshedRows(input: RefreshMergeInput): RefreshMergeResult {
  const { oldRows, freshRows, pks, userAddedFields, deletedRemoteFields = [] } = input;
  const deletedSet = new Set(deletedRemoteFields);
  const userSet = new Set(userAddedFields);

  const strip = (row: Record<string, unknown>): Record<string, unknown> => {
    const out: Record<string, unknown> = { ...row };
    for (const field of deletedSet) {
      delete out[field];
    }
    return out;
  };

  /**
   * The remote fields to key on when there is no pk: the ones BOTH sides carry,
   * minus the fields being dropped and minus the user's own columns.
   *
   * The intersection is the load-bearing part. Keying on every fresh field
   * would break the moment the source grew a column — the new field is absent
   * from every old row, so every key would differ and nothing would match, in
   * exactly the situation (a source that changed) where a refresh matters most.
   * Sorted, so the key does not depend on the order the source lists them in.
   */
  const oldFields = new Set(oldRows.flatMap((r) => Object.keys(r.data)));
  const contentFields = [...new Set(freshRows.flatMap((r) => Object.keys(r)))].filter((f) => oldFields.has(f) && !deletedSet.has(f) && !userSet.has(f)).sort();

  const byPk = pks.length > 0 && freshRows.every((row) => hasAllPkValues(row, pks));
  // With no fields to key on, every row hashes the same and the first old
  // row's values would be smeared across all of them. Carry nothing instead.
  const strategy: MergeStrategy = byPk ? 'pk' : contentFields.length > 0 ? 'content' : 'none';

  if (strategy === 'none') {
    return {
      data: freshRows.map(strip),
      merged: false,
      strategy,
      droppedUserRows: oldRows.filter((r) => holdsUserValue(r.data, userAddedFields)).length,
    };
  }

  const fields = strategy === 'pk' ? pks : contentFields;
  const oldByKey = new Map<string, { data: Record<string, unknown> }>();
  for (const oldRow of oldRows) {
    const key = keyOf(oldRow.data, fields);
    if (!oldByKey.has(key)) {
      oldByKey.set(key, oldRow);
    }
  }

  const matched = new Set<string>();
  const data = freshRows.map((freshRow) => {
    const out = strip(freshRow);
    const key = keyOf(freshRow, fields);
    const oldRow = oldByKey.get(key);
    if (oldRow) {
      matched.add(key);
      for (const field of userAddedFields) {
        if (Object.prototype.hasOwnProperty.call(oldRow.data, field)) {
          out[field] = oldRow.data[field];
        }
      }
    }
    return out;
  });

  // Count the local values that did NOT survive — an old row holding one of the
  // user's own values whose key no longer appears in the fresh set.
  let droppedUserRows = 0;
  for (const [key, oldRow] of oldByKey) {
    if (!matched.has(key) && holdsUserValue(oldRow.data, userAddedFields)) droppedUserRows += 1;
  }

  return { data, merged: true, strategy, droppedUserRows };
}

/** Whether this row has a value in any of the user's own columns worth keeping. */
function holdsUserValue(data: Record<string, unknown>, userAddedFields: string[]): boolean {
  return userAddedFields.some((f) => {
    const v = data[f];
    return v !== undefined && v !== null && v !== '';
  });
}
