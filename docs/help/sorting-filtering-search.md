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

### Typing a filter directly

You can also just type into the filter box:

| Type this | To get                              |
| --------- | ----------------------------------- |
| `*text*`  | Rows **containing** `text`          |
| `text*`   | Rows that **start with** `text`     |
| `*text`   | Rows that **end with** `text`       |
| `"text"`  | Rows that are **exactly** `text`    |
| `!text`   | Rows that do **not** match `text`   |
| `NULL`    | Rows where the value is blank/empty |
| `!NULL`   | Rows that have any value at all     |

`^text` still works as another way of writing `text*`, and `=text` as another
way of writing `"text"`.

`!` can be combined with any of them, and you can list several values separated
by commas.

### Plain text, or a list of values?

The box takes both, and it decides by what you typed:

- Type anything with a comma, `!`, `^`, `=`, `*`, `AND` or `OR` in it and it is
  read as a **list of values**.
- Type anything else and it is read as **plain text**, searched as you typed it.
- Put the **whole box in quotes** to force plain text. That is the only way to
  search for a value that really contains a comma: `"Berlin, DE"`.

### What a plain value means

A value with no wildcard and no quotes — just `Paris` — follows the **Default to
substring** setting (Settings → Table grid), which is on to start with:

- **On** — `Paris` matches any cell containing "Paris".
- **Off** — `Paris` matches only a cell that is exactly "Paris", which is
  usually what a list of values is for.

Either way `*Paris*` and `"Paris"` say which they want and ignore the setting.
The setting belongs to the workspace, not to your device, because it decides
what the filters saved in that workspace mean.

A comma means OR. To ask for two things at once, put `AND` between them:

| Type this         | To get                               |
| ----------------- | ------------------------------------ |
| `Sweden,Norway`   | Sweden **or** Norway                 |
| `!NULL AND Biden` | Has a value **and** contains "Biden" |
| `^B AND !Bush`    | Starts with "B" but is not a Bush    |
| `a AND b,c`       | (a **and** b) **or** c               |
| `a OR b`          | The same as `a,b`                    |

`AND` and `OR` count as operators only in capitals and only on their own, so
"brand" and "Andrew" stay ordinary words. To search for the word itself, put
the value in quotes: `"Salt AND Pepper"`.

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

The search box takes the **same language as a filter**, across every column at
once — so `!CC,Holiday` leaves out the CC rows and keeps the Holiday ones, and
`*lida*` finds them by part of a word. An exclusion has to hold of the whole
row: `!CC` hides a row with "CC" in any of its columns.

The same rule decides plain text against a list, so an ordinary phrase needs no
syntax, and quoting the whole box searches for it exactly as typed.

A term written `field:value` narrows to one column, and takes the whole language
inside it — `city:Paris,Zurich`, `read:!true`, `status:A*`.
