# Commandlets

A **commandlet** is one URL-shaped string that names an action, its target and
its parameters:

```
goto/bible?Book=Matthew
```

The same string runs from four places: a link in a cell, the URL `#hash`, the
`?cmdlet=` boot parameter, and the command palette ("Run commandlet…").

## Shape

```
<verb>/<target>[/<target>]*[?<Column>=<filter>&<@option>=<value>]
<commandlet>;<commandlet>                        run in order, left to right
```

- The **path** carries the verb and its positional targets.
- The **query** carries everything named. A key is a **column filter** unless it
  starts with `@`, which marks a reserved **option**.

`@` rather than Datasette's leading `_`, because this app meets `_id`-style
columns routinely (the server's SQLite adapter writes `_id`) and they have to
stay filterable.

| Verb                   | Targets           | Does                                                |
| ---------------------- | ----------------- | --------------------------------------------------- |
| `goto` (alias `table`) | `<table>`         | focuses that table's window and applies the filters |
| `search`               | `<query>`         | sets the global search box                          |
| `view`                 | `<name>`?         | reveals a view window and applies the filters        |
| `cmd`                  | `<commandId>`     | runs any registered command                         |
| `preview`              | `<table>/<field>` | not wired up yet                                    |
| `ui`                   | `hide` / `show`   | not wired up yet                                    |

Options: `@search=`, `@sort=` (`-Field` for descending, comma-separated for
several keys), `@clear=1` (drop the table's existing filters first).

`view` is the one verb whose target is OPTIONAL: `view?Book==Matthew` means the
view the click came from, so one template can carry a link that narrows the view
it is already in without naming it. The current view comes from the
`<view-window>` in the click's composed path (`CommandletContext.viewInstanceId`);
typed into the palette there is no such context, and the check says to name a view
rather than guessing. A leading slash is allowed too — `#/view?…` is how a link
naturally spells a path.

A `view`'s filters land on the instance's **`pillFilters`**, not its own
`filters`. That layer shows as chips in the view's toolbar, so a link that
narrows a view can be seen and clicked off again; and the view's snapshotted
`filters` are part of how the user DEFINED it, which a navigation link must not
quietly rewrite. `@sort` does patch the instance's sort, and `@search` rides
`easydb:table-search` keyed by the INSTANCE id, so a view's search never touches
the table window showing the same rows.

An unknown first segment is read as a table name, so `bible?Book=Matthew` is the
same as `goto/bible?Book=Matthew`. A table actually called `search` needs the
explicit `goto/` form.

A filter's value is handed to `column-filter.ts` untouched, so `^`, `!`, `,`,
`NULL`, `AND` and quoting all keep their usual meaning — see
[the filter language](../help/sorting-filtering-search.md). `Chapter==5` is one
key and one value (`=5`, the exact-match prefix), not a new operator. An **empty**
value removes that filter, so a link can widen a view as well as narrow it.

## Examples

### Going to a table

| Commandlet                            | Does                                                         |
| ------------------------------------- | ------------------------------------------------------------ |
| `goto/bible`                          | opens the `bible` window and changes nothing else            |
| `goto/bible?Book=Matthew`             | …and filters `Book` to rows containing "Matthew"             |
| `goto/bible?Book==Matthew`            | exact match — `=` is the filter language's exact prefix      |
| `goto/bible?Book=^M`                  | starts with "M"                                              |
| `goto/bible?Book=!Mark`               | everything except Mark                                       |
| `goto/bible?Book=Matthew,Mark`        | Matthew **or** Mark (a comma is OR)                          |
| `goto/bible?Book=Matthew&Chapter==5`  | two columns at once — separate keys are ANDed                |
| `goto/bible?Owner=NULL`               | rows with an empty `Owner`                                   |
| `goto/people?City=%22Berlin%2C+DE%22` | a value with a comma, quoted then encoded                    |
| `bible?Book=Matthew`                  | the same as `goto/bible?…` — an unknown verb is a table name |

**A bare value is a substring match.** For the whole cell and nothing else, use
the filter language's exact prefix — which reads as a doubled `=` here, because
the first one separates the column from its filter:

```
goto/bible?Book=Matthew      contains "Matthew"     → "Matthew", "St Matthew"
goto/bible?Book==Matthew     IS exactly "Matthew"   → "Matthew"
goto/bible?Book=!Matthew     does NOT contain it    → "Mark"
goto/bible?Book=!=Matthew    is NOT exactly it      → "St Matthew", "Mark"
```

The last two are both real and they differ: `!` negates a substring match, `!=`
negates an exact one. Neither is a typo for the other.

**Columns are named by field or by label**, case-insensitively — the same rule a
`field:value` search term follows. So a column stored as `book` and labelled
"Book" answers to either. A column that exists as neither is **refused** with a
message rather than written: a filter on a field no column has cannot be seen or
cleared in the grid, and it matches nothing, so it would empty the table with
nothing on screen to explain why.

### Changing what is already on screen

| Commandlet                       | Does                                              |
| -------------------------------- | ------------------------------------------------- |
| `goto/bible?Chapter=`            | removes just the `Chapter` filter, keeps the rest |
| `goto/bible?@clear=1`            | drops every filter on the table                   |
| `goto/bible?@clear=1&Book=Mark`  | replaces the lot with one filter                  |
| `goto/bible?@sort=-Chapter`      | sorts by `Chapter`, descending                    |
| `goto/bible?@sort=-Chapter,Book` | `Chapter` descending, then `Book` ascending       |
| `goto/notes?@search=berlin`      | types "berlin" into that table's own search box   |

### Everything else

| Commandlet                              | Does                                           |
| --------------------------------------- | ---------------------------------------------- |
| `search/berlin`                         | global search across every open table          |
| `search/berlin AND active`              | the search language, so `AND`/`OR` work        |
| `search/City:Paris,Zurich`              | a field-scoped search term                     |
| `view/Reading plan`                     | opens (or fronts) that view window             |
| `view/Reading plan?Book==Matthew`       | opens it and adds a `Book` chip                 |
| `view?Book==Matthew`                    | the same, on the view the link is in            |
| `view/Reading plan?@clear`              | drops that view's chips                         |
| `cmd/windows:tile`                      | runs a registered command — ids keep their `:` |
| `cmd/app:plugins`                       | opens the Plugin Manager                       |
| `goto/bible?Book=Mark;cmd/windows:tile` | a chain: filter, then tile the windows         |

### As a link

Anywhere HTML is rendered — a column script, an `html` cell, a view template —
an `<a href="#…">` runs when clicked:

```html
<a href="#goto/orders?Customer==Smith">Smith's orders</a>
<a href="#goto/bible?Book=Matthew&@sort=-Chapter">Matthew, last chapter first</a>
<a href="#cmd/windows:cascade">tidy up</a>
```

From a column script, let the helper do the encoding and use `$TABLE` so the
same script works in any table:

```js
// A link to the orders of the person in this row.
function render(row) {
  return `<a href="${easydb.cmdlet('goto/orders', { Customer: '=' + row.name })}">orders</a>`;
}

// Re-filter the CURRENT table to everything sharing this row's status.
function render(row) {
  return `<a href="${easydb.cmdlet('goto/$TABLE', { Status: '=' + row.status })}">${row.status}</a>`;
}

// Two steps at once: filter this table, then tile the windows.
function render(row) {
  const go = easydb.cmdlet('goto/$TABLE', { Owner: '=' + row.owner });
  return `<a href="${go};cmd/windows:tile">${row.owner}</a>`;
}
```

### In the address bar

Both of these work, and both survive being pasted into a chat or a bookmark:

```
https://cawoodm.github.io/easydbaccess/#goto/bible?Book=Matthew
https://cawoodm.github.io/easydbaccess/?cmdlet=goto/bible%3FBook%3DMatthew
```

The `#hash` form needs no escaping for `?`, `=`, `&` or `;`; the `?cmdlet=` form
does, which is why the hash is the one to share. Changing the hash on a page
that is already open runs it immediately — no reload.

## Placeholders

`$NAME` is substituted **after** parsing, never before. That ordering is the
whole safety property: a value containing `&` or `;` can only ever land inside
one field instead of splitting a parameter or the chain.

| Placeholder  | Resolves to                                                |
| ------------ | ---------------------------------------------------------- |
| `$TABLE`     | name of the table the link was clicked in                  |
| `$FIELD`     | the column of the cell holding the link                    |
| `$VALUE`     | that cell's value                                          |
| `$WORKSPACE` | the current workspace id                                   |
| `$HASH`      | the whole anchor text (default-commandlet only)            |
| `$1`…`$9`    | the anchor's `/`-separated parts (default-commandlet only) |

An unknown placeholder is left visible rather than blanked, so a mistake shows
up instead of silently filtering on nothing.

## Why links go through the helper

`easydb.cmdlet(path, params)` (see the examples above) encodes every value:
`{ Customer: '=Smith & Co' }` becomes `Customer=%3DSmith+%26+Co`. Hand-writing
that URL breaks the first time a value contains `&`, `;` or `#` — the link then
silently loses a parameter or splits the chain, which is why the helper exists
rather than a note telling authors to be careful.

A click on such a link is intercepted **before** the hash changes: the click knows
its table, column and value, and that is what the placeholders resolve against.
Going through the hash would throw the context away — and would do nothing at all
on a second click of the same link, since an unchanged hash fires no
`hashchange`.

## Encoding in a hash

`#goto/bible?Book=Matthew;preview/bible/Text?Chapter==5` survives a browser
round-trip byte for byte: the WHATWG percent-encode set for fragments is only C0
controls, space, `"`, `<`, `>` and `` ` ``, so `/ ? = ; : , ! ^ $ + * ( )` all
stay literal.

A **value** must encode: space `%20`, `"` `%22`, `&` `%26` (else it splits the
params), `;` `%3B` (else it splits the chain), `+` `%2B` (`URLSearchParams`
reads `+` as a space), `#` `%23`, `%` `%25`. A literal `/` in a table or field
name is `%2F` — path segments are decoded individually, so it is not mistaken
for a separator.

The fragment is the primary carrier: it never reaches the server, it is
untouched by the `/easydbaccess/` base path, and it needs less escaping than
`?cmdlet=`, where every `&` has to be percent-encoded.

A hash that IS a commandlet runs and is then cleared, so the same link works a
second time. A hash that is **not** one (`#Matthew`) is ordinary anchor text and
is left alone — unless the workspace has a **Default commandlet**, below.

## The Default commandlet

`Settings ▸ Commandlets ▸ Default commandlet` (stored as `commandlets:default`,
workspace scope) is the template a plain anchor is turned into:

```
goto/bible?Title=$HASH&@sort=Title
```

With that set, `#Matthew` runs `goto/bible?Title=Matthew&@sort=Title`. `$HASH`
is the whole decoded anchor and `$1`…`$9` are its `/`-separated parts, so
`#psalms/23` can fill two places at once. Blank ⇒ a plain anchor does nothing,
as before.

Substitution runs after parsing, so an anchor carrying `&` or `;` lands in one
field instead of splitting the command — `#Smith %26 Co` filters for the whole
name.

## Checking one before running it

The palette entry "Run commandlet…" opens a dialog that re-checks on every
keystroke, using the same parse and lookups the runner uses
(`checkCommandletString`), so a verdict there means the same thing there. It
says what the commandlet WILL do (`✓ open bible, filter book, sort by chapter ↓`)
or why it will not (`✕ "bible" has no column "Nonesuch" — it has book, chapter`),
and Run stays disabled while it is broken. A `?` in the header links to the
[user guide](../help/commandlets.md).

Typing a commandlet straight into the palette works too: when a query matches no
command, button or table, any registered `registerCommandFallback` provider is
asked, and this plugin offers "Run this commandlet: …" for text that names a
verb. That seam is an optional addition to `UiRegistry` — the palette does not
know what a commandlet is.

## Where it lives

| Piece                                                                         | File                                                  |
| ----------------------------------------------------------------------------- | ----------------------------------------------------- |
| Grammar — parse, substitute, format. Pure, DOM-free                           | `packages/renderer/src/plugins/commandlet-lang.ts`    |
| Runner + `checkCommandletString` — one set of lookups for running and vetting | `packages/renderer/src/plugins/commandlet-run.ts`     |
| The plugin — palette entry, settings, `#hash`, `?cmdlet=`, link interception  | `packages/renderer/src/plugins/commandlets.ts`        |
| The dialog — live validation and the `?` link                                 | `packages/renderer/src/dialogs/commandlet-dialog.ts`  |
| `easydb.cmdlet()` for column scripts                                          | `packages/renderer/src/util/column-script.ts`         |
| "Windows are on screen" promise the boot entry points wait on                 | `packages/renderer/src/window-mgr/windows-ready.ts`   |
| Palette fallback seam                                                         | `registries.ts` + `dialogs/command-palette-dialog.ts` |

It is a **built-in plugin**, so the Plugin Manager can switch it off. Two core
seams were added for it: `windows-ready.ts` (because `app:ready` fires before
the window managers start, so a boot commandlet would reveal a panel that does
not exist yet) and an `easydb:set-search` listener in `app-shell.ts` (so
`search/…` fills the header box instead of narrowing rows behind its back).

Tables are addressed **by name**, like projections and view instances: a table
deleted and re-imported keeps its name but gets a new id, and a commandlet in a
bookmark has to survive that.
