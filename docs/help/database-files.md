# Database Files (desktop app)

In the desktop app your workspace is one file on your disk — a SQLite `.db`
file. This page explains how to open, save and import those files.

**This applies to the desktop app only.** In a browser tab there is no
**Database** button, because a browser tab has no files to open. Your data
there stays in the browser's own storage — see
[Getting Started](getting-started.md).

## The Database button

The **Database** button in the footer opens a small menu:

| Menu item | What it does |
|---|---|
| **Open…** | Pick a `.db` file and choose what to do with it (see below). |
| **Save As…** | Save a copy of the current file somewhere else. |
| **Import…** | Add tables from another database into the workspace you have open now. |

You can also **drag a `.db` file onto the window**. That asks the same question
as **Open…** — the two are the same path.

## Three things you can do with a .db file

When you pick or drop a database file, the app asks which one you want:

| Choice | What you get |
|---|---|
| **Open Workspace** | That file becomes your workspace. Your tables, rows and window layout come from it, and your changes go into it. |
| **Browse .db file** | A read-only look. Every table **and every view** in the file opens as a window. Nothing is written, to the file or to your workspace. |
| **Import data** | Copy tables or views into the workspace you have open now. You choose which ones. |

**Browse** is the safe choice for a file you did not make. The rows are read
from the file when you look at them, so the file is not changed at all — not
even a little. You cannot edit the values and there is no **Edit columns**
button, because the shape of the data belongs to that file, not to you.

## Your data is a real database

The `.db` file is not a private format. Each of your tables is a real table
in the file, so other programs can read it — for example DB Browser for
SQLite, or Datasette. This is also why **Import…** can work at all.

## Open Workspace

Only a file that easyDBAccess wrote can be a workspace. The app asks you to
confirm, names the file, and then shows its data.

If you pick some other SQLite file, it cannot be opened as a workspace —
there is no workspace in it. The app offers two ways forward instead:

| Choice | What happens |
|---|---|
| **Convert to EDA** | The app asks **which tables** to take, then writes a **new** file holding them as a workspace and opens it. The file you picked is not changed. |
| **Browse** | A read-only look at the file, as above. |

If the file is not a database at all, the app says so and stops.

Nothing is written to the file you picked until you agree to one of those.
Your current file is also left exactly as it is on disk.

**Convert to EDA leaves views out unless you pick one.** A view is a question
asked of the data, and this app asks such questions with a Projection instead of
SQL. Copying a view also copies rows you already have: converting the sample
`northwind.db` with its views means 1.9 million rows instead of 626 thousand.
The "skip the views" choice is there for exactly that reason. Use **Browse** or
**Import data** if you only want to look at what a view returns.

## Save As

**Save As…** copies the current file to the place you choose. From then on
you are working in that copy — the message after the copy says so.

To make a backup, use **Save As…**, or simply copy the `.db` file yourself
in your file manager. Both work, because the file is the data.

## Import

**Import…** reads any SQLite file and adds its tables **and views** to the
workspace you have open. It first shows what it found and asks which ones you
want, so nothing is written yet.

Importing a view copies the rows it returns right now into a normal table. The
view itself does not come along — see the note above about Projections.

If a table name is already used in your workspace, the app asks you what to
do — once per table:

| Choice | Result |
|---|---|
| **Overwrite** | Replace the rows of your table with the ones from the file. |
| **Rename** | Import as a new table with a free name, such as `Orders (2)`. |
| **Skip** | Leave your table alone and import nothing for it. |

At the end you get a short report: how many tables were new, renamed,
overwritten or skipped, and how many rows arrived in total.

## Save As is not the same as Export

Both write a file, but they are for different jobs:

- **Save As** copies the whole database, as a database. Open it again later
  and you get your workspace back — tables, rows and window layout.
- **Export** (see [Sharing & Sync](sharing-and-sync.md)) writes your data as
  text: CSV, SQL, or a `.db.json` dump. Use it to give data to another
  program, or to move a workspace into the browser version.

## What the file does not contain

Some things stay on the device, not in the `.db` file:

- Settings you marked **this device only**.
- Your secrets store.
- Which workspace was open last.

See [Settings](settings.md) for what is device-local and what travels with
your data. If you copy a `.db` file to another computer, expect to enter
those again there.
