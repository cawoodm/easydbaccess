# Database Files

Your workspace can be one file on your disk — a SQLite database you own, save
and hand to anyone. This page explains how.

There are two versions of this, because the desktop app and a browser tab reach
your disk in different ways:

|                 | Where the commands are                                             | File   | Saving                                            |
| --------------- | ------------------------------------------------------------------ | ------ | ------------------------------------------------- |
| **Desktop app** | **Database** button in the footer                                  | `.db`  | Every change goes straight into the file          |
| **Browser**     | **Save** in the header, plus the command palette (Ctrl+K → "file") | `.edb` | Only when you press **Save**, or turn on autosave |

Both write a real SQLite database. The rest of this page covers the desktop
first, then [the browser](#a-workspace-file-in-the-browser).

In a browser tab, files are **opt-in**. A new workspace asks you where its data
should live, and the answer can simply be "this browser" — see
[Getting Started](getting-started.md).

## No row limit, in the browser or in a file

There used to be one: a workspace kept in this browser held 10,000 rows and the
app refused the 10,001st, because the browser's old storage got slow long before
that. Browser workspaces are SQLite now — the same engine as a `.edb` file, and it
imported 120,000 rows in twelve seconds where the old storage took five minutes —
so the limit went with the storage it was measured against.

A file is still the answer for other reasons: it is yours to copy, back up and
hand over, and the desktop app opens it as it is.

## The Database button

The **Database** button in the footer opens a small menu:

| Menu item    | What it does                                                           |
| ------------ | ---------------------------------------------------------------------- |
| **Open…**    | Pick a `.db` file and choose what to do with it (see below).           |
| **Save As…** | Save a copy of the current file somewhere else.                        |
| **Import…**  | Add tables from another database into the workspace you have open now. |

You can also **drag a `.db` file onto the window**. That asks the same question
as **Open…** — the two are the same path.

## Three things you can do with a .db file

When you pick or drop a database file, the app asks which one you want:

| Choice              | What you get                                                                                                                          |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| **Open Workspace**  | That file becomes your workspace. Your tables, rows and window layout come from it, and your changes go into it.                      |
| **Browse .db file** | A read-only look. Every table **and every view** in the file opens as a window. Nothing is written, to the file or to your workspace. |
| **Import data**     | Copy tables or views into the workspace you have open now. You choose which ones.                                                     |

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

| Choice             | What happens                                                                                                                                    |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| **Convert to EDA** | The app asks **which tables** to take, then writes a **new** file holding them as a workspace and opens it. The file you picked is not changed. |
| **Browse**         | A read-only look at the file, as above.                                                                                                         |

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

| Choice        | Result                                                        |
| ------------- | ------------------------------------------------------------- |
| **Overwrite** | Replace the rows of your table with the ones from the file.   |
| **Rename**    | Import as a new table with a free name, such as `Orders (2)`. |
| **Skip**      | Leave your table alone and import nothing for it.             |

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
- Press **Save** on the workspace you already have. The first Save asks for a
  folder and then writes `<workspace>.edb` into it.

### Someone sent you a .edb? Drop it on the window

Drag the file in and its workspace becomes one of yours — `northwind.edb` arrives
as a workspace called `northwind`, and the app switches to it.

If you already have a workspace of that name, you are asked which you meant:

| Choice                          | What happens                                                                |
| ------------------------------- | --------------------------------------------------------------------------- |
| **Replace the one here**        | Your workspace of that name is removed and the file's copy takes its place. |
| **Keep both, under a new name** | The file's copy arrives as `northwind-2`, and yours is left alone.          |

A drop only **reads** the file. It does not become the file you save into — your
new workspace lives in this browser, and pressing **Save** later writes it to your
own workspace folder. That is the difference from **Open workspace file…**, which
does hand the tab over to that file.

### One workspace at a time, not the whole browser

A file holds **one workspace**, and only that workspace moves into it. Your other
workspaces stay where they are and stay in the list at the top of the window, so
you can move between them as before. A workspace kept in a file is marked 🖫.

So there is nothing to switch off. To leave a file, pick another workspace from
the list. To go back to it, pick it again — the app remembers which file each
workspace belongs to.

### One folder holds them all

The first time you save, the browser asks you to choose a **folder**. Pick one
place for your workspaces — an `easyDBAccess` folder in Documents, say.

That one permission covers everything in that folder, for good. After it:

- **Save** writes your workspace to its own file, named after it. No dialog.
- **Open workspace file…** lists the workspaces already in the folder.

**Change workspace folder…** picks a different folder later; files already saved
stay where they are. **Sync workspace folder** re-reads the one you have, for
files that arrived from another machine.

### The same folder in more than one place

Point two browsers — or two tabs on different addresses, or two machines with the
folder synced between them — at the same folder, and they share the **files** and
nothing else. Each one keeps its own working copy of a file, because a browser
gives a page storage of its own and no way to share it with another address.

So a save in one place is not seen in the other until it reads the file again,
which happens in two moments:

- **Sync workspace folder** — re-reads the folder, and if the file behind the
  workspace you are looking at has been written since you opened it, loads it and
  shows what the other one saved.
- **Switching into the workspace** — from the workspace list, or a `?space=` link.
  The file wins over your copy when it is the newer of the two.

Both stop short of throwing work away. If your copy has changes that were never
saved AND the file has been written since, the sync asks which copy you want to
keep:

| Choice                     | What happens                                                                                         |
| -------------------------- | ---------------------------------------------------------------------------------------------------- |
| **Load disk version**      | The file wins. What is here is replaced by what the other machine saved.                             |
| **Overwrite disk version** | Your copy wins, written over the file's copy of that workspace. Its other workspaces are left alone. |
| Closing the dialog         | Neither. Both copies stay as they are.                                                               |

Turn autosave on, or press **Save** before you leave, and the question does not
come up.

One thing does not survive this: a change to **settings alone**. Settings are not
counted as unsaved work — every command you run stores itself as a recent command,
so they change constantly — which means a newer file replaces them.

### Where these live

**Save** is a button in the header. Everything else is a **command**: press
**Ctrl+K** (or the **>** button in the header), type `file`, and the list shows
Open, autosave, and the workspace folder. There is no File menu — commands are
searched, so there is nothing to hunt through.

### A file is a workspace

`sales.edb` holds the workspace `sales`. Open it and that is the workspace you
land in — and if the file has no workspace of that name yet, you get an empty one
called `sales` inside it.

This is why you are never asked what to call the file: it is named after the
workspace, or it could not be found again. To get a **copy** under another name,
make a new workspace with **Clone everything** and then press **Save** — the copy
is written to its own file.

### Saving is yours to do

Nothing is written to your file until you press **Save** in the header. A **red
dot** in the corner of that button means there is something not in the file yet;
it goes when you save. This is the main difference from the desktop app, where
every change lands in the file at once.

Run **Turn on autosave** if you would rather not think about it. It saves shortly
after a change, and once at the end of an import rather than once per row.

You will not lose work in the meantime. The browser keeps its own private copy
as you go, so closing the tab, a crash or a reload all come back to where you
were. Only your `.edb` file waits for Save.

### Which browsers

Writing a file needs the File System Access API, which today means Chrome, Edge
and other Chromium browsers.

Firefox and Safari can **open** a `.edb` file, and everything in the app works
on the data. What they cannot do is write it back: Save says so instead, and the
workspace stays in the browser's own storage, where it survives a reload. Use
**Export** to get data out of those browsers.

### Moving a workspace between the browser and the desktop

A `.edb` written in the browser opens in the desktop app, and one written on the
desktop opens in the browser. Both write the same file.

One exception: a desktop workspace saved **before v0.0.357** used an older
internal layout. It does not open, in either place, and the app cannot convert
it. If you still have the desktop version you saved it with, open it there and
**Export** the tables you want — see [Sharing & Sync](sharing-and-sync.md).
