// packages/renderer/src/util/internal-fields.ts
//
// Fields that are storage plumbing rather than user data. They must stay in the
// row (SQLite's implicit `rowid` is the primary key a Datasette write targets),
// but nobody wants to look at them, so the places that DERIVE columns mark them
// `hidden` instead of dropping them.
//
// One rule, one place: both the Datasette column mapper and the projection
// editor consult this, so a column is not hidden in one path and shown in the
// other.

/** SQLite's implicit rowid — a Datasette table exposes it as a real column. */
const INTERNAL_FIELDS = new Set(['rowid']);

/** True when a field is storage plumbing that should default to hidden. */
export function isInternalField(field: string): boolean {
  return INTERNAL_FIELDS.has(field.trim().toLowerCase());
}
