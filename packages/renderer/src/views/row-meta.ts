// packages/renderer/src/views/row-meta.ts
//
// `_` — what a row knows about itself, where a template or a script can reach it.
//
// A `Row` is `{ id, tableId, data, updatedAt }`, but everything user-authored is
// handed `data` alone: a column script's `row` IS the data object, a cell
// renderer's `.row` is the data object, and a template token is a key of it. So
// the id of the record on screen — the one thing needed to build a link back to
// it, or to tell two otherwise identical rows apart — was the one thing user code
// could not see.
//
// One extra key carries the lot:
//
//   script:    row._.rowId          row._.updatedAt
//   template:  $_.rowId             $_.updated
//
// **`_`, and a nested object, on purpose.** One key is one collision risk instead
// of four, and a name nobody types as a column heading. Nesting keeps the
// namespace open: a later `_` field costs nothing, where four more top-level keys
// would each be a new way to shadow somebody's column.
//
// **Data always wins.** {@link withRowMeta} spreads `row.data` AFTER `_`, so a
// table that really does have a column called `_` keeps it and simply has no
// metadata in scripts. Shadowing a user's own column would be the worse failure —
// their script breaks, and nothing on screen says why. Template `$_.` tokens read
// the metadata directly and are not affected either way.
//
// Pure and DOM-free, so it is unit-tested in plain Node.

import type { Row } from '@easydb/shared';

/** The key {@link withRowMeta} adds, and the token name `$_.` reads. */
export const ROW_META_KEY = '_';

/**
 * What a row knows about itself.
 *
 * `updatedAt` and `updated` are the SAME instant, twice: a script wants the
 * number to compare, a template wants something a reader can read, and a token
 * cannot call a function. There is deliberately no `createdAt` — the store keeps
 * `_id` and `_updatedAt` per row and nothing else, so a creation time would have
 * to be invented.
 */
export interface RowMeta {
  /** The record's id — `Row.id`. Named `rowId`, because `row._.id` reads like a column called `id`. */
  rowId: string;
  /** The table the record belongs to. */
  tableId: string;
  /** Last write, epoch milliseconds. `0` where the store never stamped one. */
  updatedAt: number;
  /** The same instant as an ISO 8601 string, or `''` when there is none. */
  updated: string;
}

/** The metadata of one row. */
export function rowMeta(row: Row): RowMeta {
  const updatedAt = typeof row.updatedAt === 'number' ? row.updatedAt : 0;
  return {
    rowId: row.id,
    tableId: row.tableId,
    updatedAt,
    updated: updatedAt > 0 ? new Date(updatedAt).toISOString() : '',
  };
}

/**
 * One meta field by name, for the `$_.KEY` token. Unknown keys give `undefined`,
 * which a template renders as nothing — the same as an unmapped token.
 */
export function metaValue(row: Row, key: string): unknown {
  return (rowMeta(row) as unknown as Record<string, unknown>)[key];
}

/**
 * `row.data` with `_` on it — what user code is handed.
 *
 * **Memoized per `Row` object.** Cell renderers take `.row` as a Lit property and
 * redraw when its reference changes, so building a fresh object on every render
 * would redraw every renderer in the grid on every render — the same trap
 * `viz-panel`'s `elementOptions` documents for a fresh `Map`. A `WeakMap` keyed
 * on the row gives one stable object per row and releases it with the row.
 *
 * The copy is shallow, like every other read of `row.data`, and is never written
 * back: a write goes through `patchFor` / `commitCell`, which build their patch
 * from the stored `Row`, not from this.
 */
export function withRowMeta(row: Row): Record<string, unknown> {
  const hit = cache.get(row);
  if (hit) return hit;
  const out = { [ROW_META_KEY]: rowMeta(row), ...row.data };
  cache.set(row, out);
  return out;
}

const cache = new WeakMap<Row, Record<string, unknown>>();
