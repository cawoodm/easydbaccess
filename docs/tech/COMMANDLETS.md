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
| `view`                 | `<name>`          | reveals a view window                               |
| `cmd`                  | `<commandId>`     | runs any registered command                         |
| `preview`              | `<table>/<field>` | not wired up yet                                    |
| `ui`                   | `hide` / `show`   | not wired up yet                                    |

Options: `@search=`, `@sort=` (`-Field` for descending, comma-separated for
several keys), `@clear=1` (drop the table's existing filters first).

An unknown first segment is read as a table name, so `bible?Book=Matthew` is the
same as `goto/bible?Book=Matthew`. A table actually called `search` needs the
explicit `goto/` form.

```
goto/bible?Book=Matthew
goto/bible?Book=^M&Chapter==5&@sort=-Chapter
goto/notes?@search=berlin&@sort=-Date
goto/imported?_id=42
search/berlin AND active
view/Reading plan
cmd/windows:close-all
goto/bible?Book=Matthew;cmd/windows:tile
```

A filter's value is handed to `column-filter.ts` untouched, so `^`, `!`, `,`,
`NULL`, `AND` and quoting all keep their usual meaning — see
[the filter language](../help/sorting-filtering-search.md). `Chapter==5` is one
key and one value (`=5`, the exact-match prefix), not a new operator. An **empty**
value removes that filter, so a link can widen a view as well as narrow it.

## Placeholders

`$NAME` is substituted **after** parsing, never before. That ordering is the
whole safety property: a value containing `&` or `;` can only ever land inside
one field instead of splitting a parameter or the chain.

| Placeholder  | Resolves to                               |
| ------------ | ----------------------------------------- |
| `$TABLE`     | name of the table the link was clicked in |
| `$FIELD`     | the column of the cell holding the link   |
| `$VALUE`     | that cell's value                         |
| `$WORKSPACE` | the current workspace id                  |

An unknown placeholder is left visible rather than blanked, so a mistake shows
up instead of silently filtering on nothing.

## Links from a column script

A column `script` builds a link with the `cmdlet` helper, which encodes every
value:

```js
function render(row) {
  return `<a href="${easydb.cmdlet('goto/orders', { Customer: '=' + row.name })}">orders</a>`;
}
```

→ `#goto/orders?Customer=%3DSmith+%26+Co`

Hand-concatenating the URL breaks the first time a value contains `&`, `;` or
`#`, which is why the helper exists. Use `$TABLE` to keep such a script generic.

A click on that link is intercepted **before** the hash changes: the click knows
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

A hash that is **not** a commandlet (`#Matthew`) is left alone — that is ordinary
anchor text. A hash that IS one runs and is then cleared, so the same link works
a second time.

## Where it lives

| Piece                                                                        | File                                                |
| ---------------------------------------------------------------------------- | --------------------------------------------------- |
| Grammar — parse, substitute, format. Pure, DOM-free                          | `packages/renderer/src/plugins/commandlet-lang.ts`  |
| Runner — resolve the table, patch filters/sort, focus, search, run a command | `packages/renderer/src/plugins/commandlet-run.ts`   |
| The plugin — palette entry, `#hash`, `?cmdlet=`, link interception           | `packages/renderer/src/plugins/commandlets.ts`      |
| `easydb.cmdlet()` for column scripts                                         | `packages/renderer/src/util/column-script.ts`       |
| "Windows are on screen" promise the boot entry points wait on                | `packages/renderer/src/window-mgr/windows-ready.ts` |

It is a **built-in plugin**, so the Plugin Manager can switch it off. Two core
seams were added for it: `windows-ready.ts` (because `app:ready` fires before
the window managers start, so a boot commandlet would reveal a panel that does
not exist yet) and an `easydb:set-search` listener in `app-shell.ts` (so
`search/…` fills the header box instead of narrowing rows behind its back).

Tables are addressed **by name**, like projections and view instances: a table
deleted and re-imported keeps its name but gets a new id, and a commandlet in a
bookmark has to survive that.
