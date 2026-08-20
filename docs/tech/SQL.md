# Running SQL against a workspace

A workspace is an ordinary SQLite database ([`EDB.md`](./EDB.md)), so it can be
queried like one. This is the surface that makes that usable: a console in the
footer, and `api.store.sql` for plugins.

## Where it is available, and why that is a capability check

`DataStore.sql` is **optional**, and present only when the store underneath is a
real database:

| Environment | `store.sql` |
| --- | --- |
| Electron desktop | present — `node:sqlite` in the main process |
| Browser tab backed by a `.edb` file | present — sqlite-wasm in a worker |
| Browser, default storage | **absent** — that path is IndexedDB, which has no SQL |

So the test is `if (!api.store.sql) return;`, never "am I in Electron?". The
`sql-console` plugin registers no button and no command when the capability is
missing, because a button that opened a console which could only report "not
supported" is worse than no button.

This is also the clearest single argument for making SQLite the browser's only
store: the feature becomes universal the moment that lands.

## Reads cannot write, and SQLite is what guarantees it

`EdbStore.runSql` wraps a read in `PRAGMA query_only = ON`. That is a
connection-level flag SQLite enforces itself, and it is the only check worth
trusting here — deciding by the statement's leading keyword passes

```sql
WITH doomed AS (SELECT _id FROM "Parts") DELETE FROM "Parts" WHERE _id IN (SELECT _id FROM doomed)
```

straight through, and a console is exactly where somebody types that. There is a
test for that exact statement.

The pragma is restored in a `finally`. Leaving it on after a failed statement
would make every later write fail with a message pointing nowhere near the
cause.

## Writes are opt-in, and they are outside the store's rules

`{ write: true }` lifts the pragma. What it does not lift is everything
[`EDB.md`](./EDB.md) documents as load-bearing:

- The physical table name a `tables` doc points at (`_sqlTable`). `DROP TABLE`
  or `ALTER TABLE … RENAME` here leaves a registered table with nothing behind
  it.
- Additive-only column reconciliation.
- `_extra` overflow encoding.

Nor is a script transactional: statements run one at a time and an earlier one
is not rolled back when a later one fails. The console says all of this above
the checkbox rather than burying it.

After a write the store broadcasts a change for **every** collection. Raw SQL
cannot say what it touched — it may have rewritten the registry — and anything
narrower would leave a stale panel on screen.

## One statement per call

`SqlDriver.prepare` compiles the first statement of whatever it is given and
silently ignores the rest, so `runSql` is deliberately one statement. A caller
with a script splits it first:

```ts
import { splitStatements } from '@easydb/shared';

for (const { sql } of splitStatements(script)) {
  const result = await api.store.sql!.run(sql, { maxRows: 500 });
}
```

`splitStatements` is a small lexer, not a parser: it knows single-quoted
literals (including the `''` escape), all four identifier quotings SQLite
accepts (`"…"`, `` `…` ``, `[…]`), and both comment forms — enough to tell a
`;` that ends a statement from one that does not. It drops empty and
comment-only statements so the caller can run everything it gets back.

It does **not** understand `BEGIN … END` trigger bodies, whose inner `;`s each
look like a statement end. Triggers are not something this app creates; run one
as a single statement.

## The API

```ts
interface SqlRunOptions {
  params?: unknown[]; // positional bindings — always prefer these to interpolation
  write?: boolean; // default false
  maxRows?: number; // cap the rows returned
}

interface SqlRunResult {
  columns: string[]; // result order; empty when nothing came back
  rows: unknown[][]; // aligned to `columns`
  changes: number | null; // null for a read — zero would read as "a write that changed nothing"
  truncated: boolean; // `maxRows` cut it short
  elapsedMs: number;
}
```

`columns` is empty for a query that matched nothing, including a `SELECT` that
would have had columns. The driver seam hands over rows, not a description of
the shape a query would have had.

## How it is wired

| Layer | File |
| --- | --- |
| The store | `packages/shared/src/edb-store.ts` — `runSql` |
| Types | `packages/shared/src/sql-run.ts` |
| Statement splitting | `packages/shared/src/sql-split.ts` |
| Worker protocol | `renderer/src/db/edb/protocol.ts` — the `runSql` op |
| Bridge | `renderer/src/db/data-store-bridge.ts` — optional `runSql`, and the `sql` member it builds |
| Electron IPC | `electron/src/main.ts` (`store:runSql`) + `preload.ts` |
| The console | `renderer/src/dialogs/sql-console-dialog.ts` |
| The plugin | `renderer/src/plugins/sql-console.ts` |

`store:runSql` is deliberately **not** registered through `handleMutating`: that
helper reads `args[0]` as the collection that changed, which here is the
statement text.

## Tests

- `test/shared/edb-sql.test.ts` — the store on `node:sqlite`, including that a
  read cannot write and that the connection is left writable afterwards
- `test/shared/sql-split.test.ts` — the lexer
