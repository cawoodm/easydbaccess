# Sorting, Filtering & Search

## Sorting

Click a column header to sort by it. Click again to reverse the direction,
and a third click removes the sort. Numbers sort as numbers (so `10` comes
after `2`, not before), and dates sort chronologically.

![Sorting](./screenshots/sorting.png)

## Filtering a column

Click the funnel icon on a column header to open its filter. You get a
dropdown of the values that actually appear in that column (up to 500
unique values), so you can pick instead of typing.

![Filtering](./screenshots/filter.png)

Each value in the dropdown has three states, cycled by clicking it:

- **Off** (empty checkbox) — no effect.
- **On, green** — only show rows with this value.
- **On, red (negated)** — hide rows with this value.

You can turn on several values at once, mixing includes and excludes.

Each click applies at once, so there is nothing to confirm. Close the list with
**Esc**, the × in its corner, or a click outside it — the filter you built stays
on either way, and the window behind the list is not affected.

### A date column's filter

The funnel on a **date** column opens presets instead of a value list:
"Last 3 months", "Past year", "Year to date" and the like, plus a from/to
range. Presets are relative, so a saved view still means "the last three
months" whenever it is opened. Which presets show is configurable in
Settings; a **←** button switches back to the ordinary value list.

### Typing a filter directly

You can also just type into the filter box. Every example below is written
against one **City** column holding these cells:

`Bern` · `bern` · `Bernard` · `Basel` · `Berlin, DE` · `Zurich` ·
`Salt AND Pepper` · `100% wool` · `under_score` · and two blank ones.

| Type this           | What comes back                                                          |
| ------------------- | ------------------------------------------------------------------------ |
| `bern`              | `Bern`, `bern`, `Bernard` — anything **containing** it, in any case      |
| `BERN`              | The same three. Capitals never change what a filter finds                |
| `*ern*`             | The same three, said outright — the `*` means **contains**               |
| `Bern*`             | `Bern`, `bern`, `Bernard` — cells that **start with** it                 |
| `*ard`              | `Bernard` — cells that **end with** it                                   |
| `"Bern"`            | `Bern`, `bern` only — the **whole cell** is that word. `Bernard` is out  |
| `!Bern`             | Everything that does **not** match it — **including the blank cells**    |
| `!"Bern"`           | Everything that is not exactly it, so `Bernard` stays                    |
| `!Bern*`            | `Zurich`, `Salt AND Pepper`, `100% wool`, `under_score`, the blanks      |
| `NULL`              | The blank cells — empty, or nothing but spaces                           |
| `!NULL`             | Every cell that holds something. `!` on its own means the same           |
| `Bern,Basel`        | Either one — a comma is **or**                                           |
| `Bern OR Basel`     | The same thing spelled out                                               |
| `!Bern,!Basel`      | Neither one. Several exclusions all have to hold                         |
| `Bern* AND !Basel`  | `Bern`, `bern`, `Bernard`, `Berlin, DE` — starts with Bern, is not Basel |
| `Basel AND Bern,Zurich` | Only `Zurich`: `AND` binds tighter, and no cell is both              |
| `"Berlin, DE"`      | `Berlin, DE` — quote a value that contains a comma                       |
| `"Salt AND Pepper"` | The cell itself. Quotes make `AND` ordinary text                         |
| `100%`              | `100% wool`. `%` and `_` are ordinary characters here, not wildcards     |

`^Bern` still works as another way of writing `Bern*`, and `=Bern` as another
way of writing `"Bern"`. `!` can be combined with any of them.

### Comparisons

`>=`, `<=`, `>` and `<` compare instead of matching text. On a **number**
column they compare numerically; on a **date** or **datetime** column they
compare chronologically; anywhere else they compare the text.

| Type this        | What comes back                                  |
| ----------------- | ------------------------------------------------- |
| `>=2026-01-01`    | Rows dated on or after 1 Jan 2026                  |
| `<=2026-12-31`    | Rows dated on or before 31 Dec 2026                |
| `>100`            | Numbers greater than 100                           |
| `<100`            | Numbers less than 100                              |

On a **date** column a bound can also be relative, so a saved filter still
means "the last 3 months" next month:

| Type this    | Means                          |
| ------------ | ------------------------------- |
| `>=-7d`      | The last 7 days                 |
| `>=-2w`      | The last 2 weeks                |
| `>=-3m`      | The last 3 months                |
| `>=-1y`      | The last year                    |
| `>=today`    | From today on                    |
| `>=wtd`      | Since the start of this week     |
| `>=mtd`      | Since the start of this month    |
| `>=qtd`      | Since the start of this quarter  |
| `>=ytd`      | Since the start of this year     |

A `date` column's funnel also opens a picker with these as one-click presets,
plus a from/to range — see below.

Three of these surprise people:

- **`!Bern` keeps the blank cells.** A cell with nothing in it does not match
  "Bern", so it passes. Use `!Bern AND !NULL` to leave the blanks out too.
- **`AND` and `OR` are operators only in capitals and only on their own**, so
  "brand" and "Andrew" stay ordinary words.
- **`*` is a wildcard, but only outside quotes.** `"a*b"` looks for a value that
  really holds an asterisk, and `*` on its own does too.

On a **list** column each token is matched against one member rather than the
whole cell, so `"red"` finds the rows whose list contains exactly `red` — with
`green` or anything else alongside it.

### What a plain value means

A value with no wildcard and no quotes — just `Bern` — follows the **Default to
substring** setting (Settings → Table grid), which is on to start with:

- **On** — `Bern` matches any cell containing "Bern".
- **Off** — `Bern` matches only a cell that is exactly "Bern", which is usually
  what a list of values is for.

Either way `*Bern*` and `"Bern"` say which they want and ignore the setting.
The setting belongs to the workspace, not to your device, because it decides
what the filters saved in that workspace mean.

### Filters narrow each other (faceting)

Picking a value in one column's filter narrows what shows up in every other
column's dropdown. For example, filtering **Country = Sweden** narrows the
**City** dropdown down to Swedish cities — but the **Country** dropdown
itself keeps listing every country, so you can always widen your filter
again.

A column with long, free-text values (a description field, say) won't offer
a dropdown at all — only a plain typed filter — since a value list wouldn't
be useful there.

### Filtering a very big table

A filter always covers every row, however big the table is. What is limited is how
many rows come back: at most 20,000 at a time. If your filter matches more than that,
the grid says so and gives the real number, so you can narrow the filter further.

A filter that matches 3 rows in a table of 600,000 shows you those 3 rows.

### The value list of a big table

A big table is read one page at a time (see [Settings](settings.md)), so the
dropdown can only offer the values on the rows loaded so far. It says as much, and
puts a **refresh** icon next to that line. Press it to read the real list of values
for the whole column.

It is never done for you, because opening the funnel has to be instant, and the rows
you already have usually hold the value you are looking for.

### A filter on a hidden column

A hidden column has no header, and so no funnel to open. Its filter keeps
working, which can look like rows that have gone missing for no reason.

Open the column editor to see it: a blue funnel is shown on every column that
has a filter, whether the column is hidden or not. Click the funnel to switch
that filter off, and click it again to bring it back. The change applies when
you press Save.

## Columns you cannot search

A column whose value comes from a script holds nothing of its own — the value is
worked out from the row each time it is shown. Searching it would look at empty
cells and find nothing, so it offers no funnel and the search skips it. Give the
column real data and it becomes searchable again by itself.

## Search

Each table has its own local search box (an icon that expands into a text
field), and the header has a global search box that searches every open
table at once. Filters, local search, and global search all apply together
— a row has to pass all three to show up.

The header box **stays open while it holds a query**, so what every table on
screen is being filtered by is always readable — click into a table to look at
the results and the words are still there, with the × to clear them. Empty it and
the box folds back to its icon on the next click elsewhere.

Typing multiple words searches for the whole phrase first, then falls back
to every word (AND), then to any word (OR). You can also spell out the logic
yourself with uppercase `AND`/`OR`, e.g. `berlin AND active`.

### The same language, across every column

A search box takes everything the filter box takes. The difference is what it
is matched against: a filter looks at **its own column**, a search looks at
**the whole row**. Say the table has a **Type** column and a **Who** column:

| Row | Type      | Who       |
| --- | --------- | --------- |
| 1   | `CC`      | `Ann`     |
| 2   | `Holiday` | `Bob`     |
| 3   | `Flat`    | `Cid`     |
| 4   | `Flat`    | `CC Dave` |

| Type this      | What comes back                                                            |
| -------------- | -------------------------------------------------------------------------- |
| `Flat`         | Rows 3 and 4 — **any** column containing it is enough                      |
| `Ann`          | Row 1. It does not matter which column the word was in                     |
| `!CC`          | Rows 2 and 3 — an exclusion has to hold of **every** column                |
| `!CC,Flat`     | Row 3 alone: has "Flat" somewhere, and "CC" nowhere. Row 4 is out on `Who` |
| `*lida*`       | Row 2 — the wildcards work here too                                        |
| `=Flat`        | Rows 3 and 4 — some column is exactly that                                 |
| `Flat AND Cid` | **Nothing.** `AND` asks ONE column to hold both, and no column does        |

The rules to remember: a value you want is looked for in any column, a value you
don't want must be absent from all of them, and `AND` never spans two columns.
To ask for "Flat in one column and Cid in another", use two column filters, or
search `Flat` and filter `Who` for `Cid`.

### Plain text, or a list of values?

The search box takes both, and it decides by what you typed:

- Type anything with a comma, `!`, `^`, `=`, `*`, `AND` or `OR` in it and it is
  read as a **list of values**, exactly as a filter would.
- Type anything else and it is read as **plain text**, searched as you typed it.
- Put the **whole box in quotes** to force plain text. That is the only way to
  search for a phrase that really contains a comma: `"Berlin, DE"`.

A term written `field:value` narrows to one column, and takes the whole language
inside it — `city:Paris,Zurich`, `read:!true`, `status:A*`.
