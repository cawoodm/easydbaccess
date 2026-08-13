# Sharing & Sync

## Exporting

**Export** in a table's toolbar exports that table. **Export** in the footer
exports the workspace, and asks which tables to include when there is more than
one. Both open the same dialog.

Pick a format — **CSV**, **JSON** or **SQL** — then say what to write:

| Option | What it means |
| --- | --- |
| Limit rows | `0` writes every row. Any other number writes that many. |
| Columns | **Visible** leaves out the columns you have hidden. **All** writes them. |
| Rows | **Filtered** writes only the rows your filters keep. |
| Order | **Sorted** writes them in the table's sort order. |
| Values | **Rendered** writes a date in your own time and an array as a list. **Raw** writes what is stored. |
| Run scripts | Fills a column that computes its value instead of storing one. |

Each format then has its own options. CSV offers the separator, whether to write
a header row, a byte-order mark (tick it if Excel shows accented characters
wrongly) and a **typed header** — this writes the column types into the header
line, so importing the file again restores them instead of guessing. JSON offers
indenting and whether to carry your views along.

A limit is taken AFTER filtering and sorting, so "the first 100, sorted" really
is the first 100 of the sorted table.

One table exported as JSON gives a `.table.json`. Several give one `.db.json`
holding them all — every table, its rows and your window layout, in one file you
can drop back in later to restore everything. CSV has no shape for several
tables, so it writes one file each.

A big table warns you before it reads every row: a table over 50,000 rows is not
held in memory while you work with it, and exporting all of it puts it there. Set
a limit if you only need the first rows.

## Backing up and moving between devices

There's no proprietary format — a `.db.json` file is plain JSON you can
version-control, email, or store anywhere. Drop it back onto the window to
restore it.

In the desktop app you have a second way: your workspace already **is** a
file, so **Database → Save As…** makes a backup copy of the whole database,
and **Database → Open…** opens one again. See
[Database Files](database-files.md).

## Syncing to other devices

Two ways to sync, pick one — or neither:

### Your own server

Run the small bundled server anywhere (a Raspberry Pi, a free hosting tier,
your own machine). The footer's **Sync** menu gives you **Push** (send your
workspace up) and **Pull** (bring the server's copy down). If someone else
pushed since your last pull, easyDBAccess detects the conflict and won't
silently overwrite anything.

### A private GitHub Gist

No server to run — your workspace lives as a private Gist. The footer's
**Gist** menu gives you:

- **Push / Pull** — send or fetch the whole workspace. You can also choose
  a narrower scope: **data only** (tables and rows) or **settings only**
  (views and configuration), instead of everything.
- **Share** — generates a link that loads your workspace connection on
  another device.
- **View gist** — opens the Gist on GitHub.

A table connected to a live source (like a Datasette instance) only syncs
its **definition** through Gist or server sync, never its rows — since those
rows already live at the source and would just be re-fetched there.

## Keeping secrets out of your data

Tokens (like a GitHub personal access token) are never stored as plain text
in your synced workspace. They live in a separate, device-local secrets
store, and settings reference them by name (e.g. `${secret:gist_token}`)
instead of holding the value directly. See
[Settings & Plugins](settings-and-plugins.md) for where to manage them.
