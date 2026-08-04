// packages/renderer/src/util/table-names.ts
//
// The naming policy for tables. It lives in `util/` and not in `import/`
// because it is no longer an import concern: the store enforces it on every
// write (`db/unique-table-names.ts`), and importers only call it to know the
// name in advance.

/**
 * One naming policy for every writer. `taken` is compared case-insensitively,
 * because the workspace treats names case-insensitively elsewhere (the columns
 * editor refuses a clash that differs only in case) and two tables differing
 * only in case is a trap.
 *
 * Replaces four competing rules: `-2` (references), ` (2)` (Datasette), a
 * base36 timestamp (CSV, which produced names like `places (m8x1k2)`) and
 * "no rule at all" (a dump added as new tables, which duplicated the name).
 */
export function uniqueTableName(taken: Iterable<string>, base: string): string {
  const lower = new Set([...taken].map((n) => n.toLowerCase()));
  const seed = base.trim() || 'imported';
  if (!lower.has(seed.toLowerCase())) return seed;
  for (let i = 2; ; i++) {
    const candidate = `${seed}-${i}`;
    if (!lower.has(candidate.toLowerCase())) return candidate;
  }
}
