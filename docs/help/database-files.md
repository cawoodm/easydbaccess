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
| **Open…** | Close the current file and show the data from another file. |
| **Save As…** | Save a copy of the current file somewhere else. |
| **Import…** | Add the tables from another database into the workspace you have open now. |

## Your data is a real database

The `.db` file is not a private format. Each of your tables is a real table
in the file, so other programs can read it — for example DB Browser for
SQLite, or Datasette. This is also why **Import…** can work at all.

## Open

**Open…** shows a file picker. It then asks you to confirm, and names the
file you picked.

Open only accepts a file that easyDBAccess wrote. If you pick some other
SQLite file, the app tells you so and offers to **import** its tables
instead — it keeps the file you picked, so you do not have to find it again.
If the file is not a database at all, the app says that too.

Nothing is written to the file you picked until you agree to one of those.
Your current file is also left exactly as it is on disk.

## Save As

**Save As…** copies the current file to the place you choose. From then on
you are working in that copy — the message after the copy says so.

To make a backup, use **Save As…**, or simply copy the `.db` file yourself
in your file manager. Both work, because the file is the data.

## Import

**Import…** reads any SQLite file and adds its tables to the workspace you
have open. It first shows what it found, so nothing is written yet.

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
