# Refresh

How a table reloads from where it came from — what happens today, what it costs
the user, and how it could work better.

Refresh is not sync. [`SERVER.md`](./SERVER.md) and the gist/server-sync plugins
move a whole workspace between devices. Refresh moves ONE table's rows in ONE
direction: from the source it was made from, into the table. Nothing a refresh
does ever travels back to the source.

## 1. The two kinds of table

Everything about refresh follows from which of these a table is. There is no one
classifier: each plugin's Refresh button re-derives the answer inline in its
`visible` predicate, from `table.origin?.type` and `table.source?.type`. That is
four copies of the same question, and §5.7 is where they become one.

|                       | **Copy** (snapshot)                  | **Reference / Connected** (live)         |
| --------------------- | ------------------------------------ | ---------------------------------------- |
| Marked by             | `table.origin`                       | `table.source`                           |
| Rows stored in Dexie  | yes                                  | no                                       |
| Rows synced           | yes                                  | no (definition only)                     |
| Editable              | unless `table.readonly`              | connected: if writable. reference: no    |
| What Refresh does     | re-read the source, write rows again | drop a cache, re-read                    |
| What Refresh can lose | see §3                               | nothing — there is nothing local to lose |

A live table's refresh is uninteresting, and that is the point: it holds no
local state, so re-reading cannot conflict with anything. All the hard questions
below are about **Copy**.

## 2. What runs today

Four buttons, all labelled "Refresh", registered by four plugins. Each has a
mutually-exclusive `visible` predicate, so a table shows exactly one.

| Table                            | Button owner        | Entry point                               |
| -------------------------------- | ------------------- | ----------------------------------------- |
| `origin.type` is `csv` or `json` | `import-data`       | `import/refresh.ts` → `refreshFromOrigin` |
| `origin.type` is `datasette`     | `datasette-import`  | `refreshSnapshot`                         |
| `source.type` is `datasette`     | `datasette-connect` | `refreshLiveTable`                        |
| `source.type` is `url`           | `url-source`        | inline: `coll.refresh()`                  |

Plus a fifth, red button — **Resume import** (`datasette-import`) — shown only
while `table.importResume` holds a cursor from a paged read that was cut short.

### 2.1 The live paths

`refreshLiveTable` and `url-source`'s handler are three lines each: call
`coll.refresh()` on the routed collection so it drops its cache, then
`coll.find()` to repopulate and notify the grid. The provider owns the fetch.

### 2.2 The snapshot paths

Both do the same five steps. `refreshFromOrigin` is the generic one, driven by
whichever `ImporterSpec` made the table; `refreshSnapshot` is Datasette's, which
additionally pages, drives a per-window progress bar and records a resume
cursor.

1. **Re-read the source.** The generic path calls the importer's own
   `list()` then `read()`, so it reuses exactly the code that did the original
   import. It matches the candidate by table NAME, which matters for a
   multi-table source — a single-table source falls back to "the only one".
2. **Reconcile columns** — `table/column-merge.ts:reconcileColumns`:
   - every existing column is kept exactly as arranged (order, label, type,
     width, renderer, hidden, description);
   - a field in `table.deletedColumns` is never re-added;
   - anything else incoming is appended, and reported as `newFields`.
3. **Merge rows** — `table/refresh-merge.ts:mergeRefreshedRows`:
   - fields in `deletedColumns` are stripped from both sides;
   - with `origin.pks`, match old row to fresh row by primary key and copy the
     user's own columns (`userAddedFields`) onto the fresh row;
   - **without pks, fall back to fresh-only** and report `merged: false`.
4. **Write.** Patch the columns, delete every local row, insert the merged set.
5. **Report.** A toast. Datasette's path additionally opens the column editor
   when `newFields` is non-empty (`easydb:edit-columns`); the generic path only
   mentions the count in the toast.

## 3. What this costs the user

These are consequences of the design above, not bugs in the code.

### 3.1 A row edit to a remote column is always lost

Deliberate, and correct as a default: the source is the authority for its own
columns. But nothing warns first. A user who fixed a typo in an imported table,
then clicked Refresh a week later, silently loses that fix. There is no record
that a cell was ever edited, so we could not warn even if we wanted to.

### 3.2 Without a primary key, a user's own columns lose their values

Only Datasette records `origin.pks`. A CSV or JSON snapshot therefore takes the
fresh-only path: the user's extra column **survives as a column** (step 2 keeps
it) but every value in it is dropped, because there is no way to say which old
row a fresh row corresponds to. The toast says "rows replaced (no primary key to
match on)", which is honest but not much comfort.

A CSV has no declared key. Guessing one is a real inference problem: a column
that is unique across the rows we happen to have is not necessarily a key.

### 3.3 A locally deleted row comes back

Rows are rebuilt from the fresh set, so a row the user deleted reappears on the
next refresh. Whether that is right is genuinely ambiguous — "this row is
noise, hide it" and "this row was stale, the source has since fixed it" are
different intents and we cannot tell them apart. Today the source always wins.

### 3.4 A column disappearing from the source is not noticed

`reconcileColumns` only ever ADDS. If the source drops a column, the table keeps
it, and every fresh row simply has no value for it — so the column stays,
quietly filling with blanks. Nobody is told. There is no way to distinguish
"the source removed this column" from "this column is one the user added".

### 3.5 A type change on the remote is ignored

An existing column keeps its `type` and `renderer`, by design — the user may
have chosen them. So a source column that changes from text to number keeps
being treated as text. Correct for the user's arrangement, wrong about the data.

### 3.6 The whole table is rewritten every time

Every local row is deleted and re-inserted, even when nothing changed. The calls
are batched (`bulkRemove` then `bulkInsert`), but on a 10,000-row table that is
still 10,000 deletes and 10,000 inserts, and every row gets a fresh
`cryptoUUID()` — so every row id changes, which breaks anything holding one. It
also means a refresh interrupted between the delete and the insert leaves the
table empty. (Datasette's paged read has a resume cursor for the FETCH, but
nothing covers the write.)

### 3.7 Two paths still behave differently

The generic path does not open the column editor on new columns; Datasette's
does. Datasette's has a progress bar and a resumable read; the generic one has
neither. Same button, same label, different behaviour — the remaining half of
phase F in
[`.claude/plans/2026-07-28-importer-architecture.md`](../../.claude/plans/2026-07-28-importer-architecture.md).

## 4. Related open work

From `TODO.md`, items that touch this:

- ~~**"Import datasette by reference doesn't prompt which tables to import and
  for no apparent reason limits to 1000 rows."**~~ Fixed in the provider, which
  is the one place that serves both a first load and a refresh:
  `url-source.ts` now follows the paging cursor (`next_url`) up to
  `MAX_REFERENCE_ROWS`, and `referenceDatasette` uses the same table picker
  Import and Connect use.
- **"For tables greater than a certain size we should not load them entirely
  into memory."** A refresh is the worst case: the fresh set, the old set and
  the merged set are all in memory at once. §3.6 gets worse with size, not
  better.
- **"When importing, automatically apply renderer link for URL fields,
  html-preview for long text…"** Landed as the `auto-renderer` plugin, which
  listens on `import:after`. A REFRESH does not emit that event, so a column a
  refresh discovers still arrives with no renderer while its neighbours have
  one — the gap this note predicted, now narrowed to one event.
- **Parked: Datasette virtual tables** (lazy server-side paging,
  `.claude/plans/2026-07-26-datasette-virtual-tables-design.md`). For a virtual
  table "refresh" stops meaning "rewrite the rows" and starts meaning
  "invalidate the window", which is closer to the live path than the snapshot
  one.

## 5. Proposal

Nothing here is implemented. It is written down so the next change to refresh
argues with a design rather than with the code.

### 5.1 Name the four outcomes, and let the user choose

Today Refresh is one verb with one hidden policy. It should be one verb with a
stated policy, the same way Import now asks "Import into" up front instead of
interrupting with a modal.

| Choice              | Rows                                                                              | Columns                                                              | For                                          |
| ------------------- | --------------------------------------------------------------------------------- | -------------------------------------------------------------------- | -------------------------------------------- |
| **Merge** (default) | source wins per remote field; the user's own fields and rows are preserved by key | reconcile, as today                                                  | the normal case                              |
| **Replace rows**    | drop everything local, take the source verbatim                                   | reconcile                                                            | "my local state is junk, start over"         |
| **Re-create**       | as Replace                                                                        | take the source's schema verbatim, discarding the user's arrangement | "the source changed shape, I want its shape" |
| **Preview only**    | write nothing                                                                     | write nothing                                                        | "tell me what would change"                  |

Where it should be asked: **not** a modal on every click. Refresh is a frequent,
routine action and a prompt every time is a tax. Instead:

- the table remembers its policy (`origin.refreshPolicy`), defaulting to Merge;
- the button does that silently;
- the button's menu (it is already an anchored-menu pattern elsewhere) offers
  the other three, and the chosen one becomes the remembered default;
- and a refresh **escalates to a prompt by itself** when it detects something it
  cannot decide — see §5.3.

### 5.2 Make the schema diff a first-class result

`reconcileColumns` returns only `newFields`. It should return a full diff, and
refresh should act on all of it:

```
added:    in source, not in table        -> append (as today)
removed:  in table, was from the source, no longer in it
renamed:  removed + added with the same values (a guess, needs confirming)
retyped:  same field, different inferred type
userOnly: in table, never from the source -> leave alone (as today)
```

`removed` is the gap that matters (§3.4). Knowing a column CAME from the source
means recording which fields the source owned — one string array on
`TableOrigin`, e.g. `origin.remoteFields`, written at import time. That is the
smallest change that unlocks the rest, and it is not an indexed field, so no
Dexie version bump.

With that, a removed column can be reported ("the source no longer has
`canton` — keep it as your own column, or drop it?") instead of silently going
blank.

### 5.3 Escalate, do not ask by default

A refresh should prompt only when it finds something a policy cannot answer:

- a column vanished from the source and holds data (§3.4);
- a column's type changed and the user had not overridden it (§3.5);
- the row count fell by more than some fraction — a good signal that the URL now
  points at something else, or the source is mid-deploy;
- `merged: false` on a table that HAS user-added columns, i.e. the case in §3.2
  where the user is about to lose values. Today this is a toast after the fact;
  it should be a question before it.

Everything else proceeds silently. The rule: prompt when the user is about to
lose something they made, never merely because data changed.

### 5.4 Give a snapshot a key, even a synthetic one

§3.2 exists because CSV/JSON have no key. Options, cheapest first:

1. **Let the user nominate one.** The column editor already knows about
   `unique`; a "use as key for refresh" flag on one or more columns is a small
   UI addition and puts the judgement where the knowledge is.
2. **Offer a candidate.** At import time, any column whose values are unique and
   non-empty across the whole import is a candidate; propose it, do not assume
   it.
3. **Positional fallback.** Match old row _n_ to fresh row _n_. Cheap, and
   correct for an append-only export — but silently wrong the moment a row is
   inserted in the middle, which is worse than not merging. Only worth it if the
   user opts in per table.

Option 1 first. It is honest about who knows the answer.

### 5.5 Stop rewriting rows that did not change

§3.6 is fixable without any new model field: hash each fresh row's data, compare
to the stored row's, and only write the ones that differ. That turns the common
"nothing changed upstream" refresh from 20,000 operations into a read plus a
comparison, keeps row ids stable, and makes an interrupted refresh far less
destructive because there is no delete-then-insert window.

With a key (§5.4) this becomes a proper three-way diff and the writes can be
`patch` per changed row, `insert` for new keys, `remove` for gone keys — which
is also what would let a refresh report "12 changed, 3 added, 1 removed" rather
than "471 rows".

### 5.6 Preview

Once §5.2 and §5.5 exist, "Preview only" is nearly free: run the whole refresh
into memory, report the diff, write nothing. It is the honest answer to every
"what will this do to my edits?" and it makes the destructive choices safe to
offer.

### 5.7 Fold the paths into one

The remaining half of phase F. Two things block a single dispatcher, and both
are Datasette-specific capabilities the kernel cannot express:

- a **per-window progress bar** during a long read — `LandOptions.onProgress`
  already exists on the write side, so the kernel could drive
  `setTableLoading` for every importer;
- a **resumable cursor** — `ImportBatch.nextCursor` already exists on the
  contract, so the kernel could persist `importResume` when a read ends early.

Both are additive. Once they land, `datasette-import` keeps its paging inside
`read()` where it belongs, and there is one refresh, one button, one policy.

## 6. Where the code is

| File                           | Holds                                                              |
| ------------------------------ | ------------------------------------------------------------------ |
| `import/refresh.ts`            | `refreshFromOrigin` — the generic snapshot refresh                 |
| `table/column-merge.ts`        | `reconcileColumns`, `rowRekeyer`                                   |
| `table/refresh-merge.ts`       | `mergeRefreshedRows` — the pk-matched row merge                    |
| `plugins/datasette-import.ts`  | `refreshSnapshot`, `resumeImport`, `openColumnEditorForNewColumns` |
| `plugins/datasette-connect.ts` | `refreshLiveTable`                                                 |
| `plugins/url-source.ts`        | the reference collection and its Refresh                           |
