# Commandlets

A **commandlet** is a short piece of text that tells easyDBAccess to do
something — open a table, filter it, search, run an action:

```
goto/bible?Book=Matthew
```

Read it as a web address: the part before the `?` says **what to open**, and the
part after it says **with what**. You can type one into the command palette
(**Ctrl+K** → "Run commandlet…"), put one in a link, or put one after a `#` in
the address bar.

## Opening a table

| Type this                           | And you get                                          |
| ----------------------------------- | ---------------------------------------------------- |
| `goto/bible`                        | the `bible` window, in front                         |
| `goto/bible?Book=Matthew`           | …showing only rows whose **Book** contains "Matthew" |
| `goto/bible?Book==Matthew`          | rows whose Book is **exactly** "Matthew"             |
| `goto/bible?Book=!Matthew`          | rows whose Book does **not** contain it              |
| `goto/bible?Book=Matthew,Mark`      | Matthew **or** Mark                                  |
| `goto/bible?Book=^M`                | Book **starts with** "M"                             |
| `goto/bible?Owner=NULL`             | rows with an empty Owner                             |
| `goto/bible?Book=Matthew&Chapter=5` | two columns at once                                  |

Everything after `Column=` is an ordinary column filter, the same thing you type
into a funnel — see [Sorting, Filtering & Search](sorting-filtering-search.md).

Name a column by its heading **or** by its underlying field name; upper and
lower case don't matter. Naming a column that doesn't exist is refused with a
message, so a typo can't leave you staring at an empty table.

## Changing what you are looking at

| Type this                   | And you get                                 |
| --------------------------- | ------------------------------------------- |
| `goto/bible?Chapter=`       | the Chapter filter removed, the others kept |
| `goto/bible?@clear=1`       | every filter cleared                        |
| `goto/bible?@sort=Chapter`  | sorted by Chapter                           |
| `goto/bible?@sort=-Chapter` | sorted by Chapter, **highest first**        |
| `goto/bible?@search=grace`  | "grace" typed into that table's search box  |

Anything beginning with `@` is an instruction rather than a column, which is why
a column of your own called `sort` still filters normally.

## Leaving the table name out

Drop the name and `goto` means **the table you are in**:

| Type this            | And you get                                     |
| -------------------- | ----------------------------------------------- |
| `goto?Book=Matthew`  | this table filtered, whichever table it is      |
| `goto?@sort=-Rating` | this table sorted                               |
| `goto?@clear`        | this table's filters cleared                    |

That is what makes a link worth writing once. A custom HTML visualization, or a
cell script that builds a link, can carry `#goto?Country==CH` and work on every
table it is used with — naming the table would tie it to one. It is the same
shortcut `view?…` already offers for the view you are in.

Typed into the command palette there is no table you are in, so it says so
rather than guessing one and quietly filtering something you are not looking at.

## The other things it can do

| Type this                               | And you get                            |
| --------------------------------------- | -------------------------------------- |
| `search/berlin`                         | a search across every open table       |
| `view/Reading plan`                     | that view's window                     |
| `view/Reading plan?Book==Matthew`       | that view, narrowed to Matthew         |
| `view?Book==Matthew`                    | the view you are already in, narrowed  |
| `cmd/windows:tile`                      | any action from the palette, by its id |
| `preview/notes/n-17`                    | one record's text, in a small window   |
| `goto/bible?Book=Mark;cmd/windows:tile` | both, in order — `;` joins them        |

A `view/…` narrows the view the way `goto/…` narrows a table, and what it adds
shows up as a chip in the view's toolbar — so you can click it off again, and the
filters you gave the view when you made it are left alone. Leave the name out
(`view?Book==Matthew`) inside a view template and it means *this* view.

## Showing one record without going to it

`preview/…` is the odd one out: it opens a small window with one cell in it and
changes nothing else. Nothing is filtered, nothing is focused — so a link in a
view can show you a related record without disturbing what you were reading.

| Type this                          | And you get                                    |
| ---------------------------------- | ---------------------------------------------- |
| `preview/notes/Body?Title==Berlin` | the Body of the note titled Berlin             |
| `preview/notes/n-17`               | record `n-17` — the field is picked for you    |
| `preview/notes/Body/n-17`          | the Body of record `n-17`                      |

The middle form is the short one. A key is matched against the table's **first
column**, which is assumed to be the id, and the field shown is the first one
that looks like prose: a column set to the **markdown** or **preview** renderer,
then a **text** column, then simply the second column.

The second thing you type is read as a **column name** if the table has one by
that name, and as a **key** otherwise. So when a record id happens to be spelled
like one of your columns, use the three-part form, which never guesses.

If the filter matches more than one row you get the first one and a warning
saying how many there were. If it matches none, you get a message rather than an
empty window.

Markdown and preview columns are shown formatted, as if you had clicked the
popup icon in the cell. Every other column is shown as plain text — a preview is
for reading, so it never offers an editor onto a record you may not have open.

## Links

Anywhere you can write HTML — a column script, an HTML cell, a view template —
a link starting with `#` runs when clicked:

```html
<a href="#goto/orders?Customer==Smith">Smith's orders</a>
```

In a column script, build the link with `easydb.cmdlet(...)` so that values
containing `&` or spaces are handled for you, and use `$TABLE` when you want the
same script to work in any table:

```js
function render(row) {
  return `<a href="${easydb.cmdlet('goto/orders', { Customer: '=' + row.name })}">orders</a>`;
}
```

## Sharing one

Put it after a `#` and the whole address is shareable:

```
https://cawoodm.github.io/easydbaccess/#goto/bible?Book=Matthew
```

Opening that link opens the workspace with the table filtered. Changing the `#`
on a page that is already open works too — nothing reloads.

## Turning plain anchors into an action

An anchor like `#Matthew` has no verb, so on its own it does nothing. Give
**Settings ▸ Commandlets ▸ Default commandlet** a template and every plain
anchor runs it:

```
goto/bible?Title=$HASH&@sort=Title
```

Now `#Matthew` opens `bible`, filters **Title** to "Matthew" and sorts by Title.
`$HASH` is the whole anchor; `$1`, `$2` … are its parts if you separate them
with `/`, so `#psalms/23` can fill in two different places.

## When something doesn't work

The "Run commandlet…" dialog checks what you type as you type it and says what
it will do — or what is wrong with it — before you run it. A commandlet that
fails elsewhere (a stale link, say) says why in a message at the top of the
window.
