# Database Files

Your workspace can be one file on your disk — a SQLite database you own, save
and hand to anyone. This page explains how.

There are two versions of this, because the desktop app and a browser tab reach
your disk in different ways:

| | Button | File | Saving |
|---|---|---|---|
| **Desktop app** | **Database** | `.db` | Every change goes straight into the file |
| **Browser** | **File** | `.edb` | Only when you press **Save**, or turn on autosave |

Both write a real SQLite database. The rest of this page covers the desktop
first, then [the browser](#a-workspace-file-in-the-browser).

In a browser tab, files are **opt-in**. A new workspace asks you where its data
should live, and the answer can simply be "this browser" — see
[Getting Started](getting-started.md).

## 10,000 rows in a browser, and no limit in a file

**A workspace kept in this browser holds 10,000 rows.** Import more and the app
refuses it and tells you so — nothing is half-imported.

That is not a licence check, it is what the browser's own database can do well. The
same table of 120,000 rows takes over five minutes to import into a browser
workspace, five seconds to count and six to filter. In a `.edb` file it imports in
twelve seconds, counts instantly and filters in a fifth of a second. So the limit
is set where the browser is still quick, and the way past it is a file:

**File → New .edb file…** in the window footer. It copies the workspace you are in
to the file you name, and from then on there is **no row limit** — the same file
also opens in the desktop app as it is.

The desktop app has no limit anywhere: its workspaces are always SQLite files.

A workspace that is already over the limit — filled before this rule, or on another
machine — keeps working. You can read it, edit it, sort it, filter it and delete
from it. You just cannot add to it until you move it into a file.

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

## A workspace file in the browser

A browser tab can keep a workspace in a `.edb` file — the same idea as the
desktop's `.db`, and the same real SQLite inside. It is off until you ask for it.

Two ways to start:

- **New workspace** asks where its data should live. Pick **Advanced** and it
  goes in a file.
- The **File** button in the footer turns the workspace you already have into a
  file: **New .edb file…** → **Copy this workspace into it**. Your browser copy
  is left exactly as it was, so you can go back to it.

### One workspace at a time, not the whole browser

A file holds **one workspace**, and only that workspace moves into it. Your other
workspaces stay where they are and stay in the list at the top of the window, so
you can move between them as before. A workspace kept in a file is marked 🖫.

So there is nothing to switch off. To leave a file, pick another workspace from
the list. To go back to it, pick it again — the app remembers which file each
workspace belongs to.

### One folder holds them all

The first time you use a file, the browser asks you to choose a **folder**. Pick
one place for your workspaces — a `easyDBAccess` folder in Documents, say.

That one permission covers everything in that folder, for good. After it:

- **New .edb file…** just asks for a name.
- **Open .edb file…** lists the workspaces already in the folder.

No file dialog either time. **Workspace folder…** in the same menu changes it
later; files already saved stay where they are.

### Saving is yours to do

Nothing is written to your file until you press **Save**. This is the main
difference from the desktop app, where every change lands in the file at once.

**Turn on autosave** in the **File** menu if you would rather not think about
it. It saves shortly after a change, and once at the end of an import rather
than once per row.

You will not lose work in the meantime. The browser keeps its own private copy
as you go, so closing the tab, a crash or a reload all come back to where you
were. Only your `.edb` file waits for Save.

### Which browsers

Saving in place needs the File System Access API, which today means Chrome,
Edge and other Chromium browsers.

In Firefox and Safari the **File** menu still works, but Save hands you a
**download** instead of writing back to the file you opened, and there is no
folder to choose. Opening a file works everywhere.

### Moving a workspace between the browser and the desktop

A `.edb` written in the browser opens in the desktop app, and one written on the
desktop opens in the browser. Both write the same file.

One exception: a desktop workspace saved **before v0.0.357** used an older
internal layout. It does not open, in either place, and the app cannot convert
it. If you still have the desktop version you saved it with, open it there and
**Export** the tables you want — see [Sharing & Sync](sharing-and-sync.md).
