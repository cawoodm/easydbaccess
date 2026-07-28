# Importing Data

## Drag and drop a file

Drop a CSV, TSV, or JSON file anywhere on the window. The first row becomes
your column headers, and each column's type (number, date, boolean, or text)
is guessed automatically from the data.

![Import CSV](./screenshots/import-csv.png)

If a table with the same name already exists, you're asked whether to
**append**, **overwrite**, or create a **new table** instead.

## Defining columns up front

Instead of relying on guessed types, you can start a CSV with a header line
that spells out each column using a small mini-language:

```
field:label:type:default:max:flags
```

For example:

```csv
id:ID:number::unique,notnull,name:Full Name:string:::,email:Email:string::unique,joined:Joined On:date::,active:Active:boolean::
```

Looking at each line:

- `id:ID:number::unique,notnull` A unique `id` field which may not be empty (like a primary key)
- `name:Full Name:string` A `name` field displayed as `Full Name`
- `email:Email:string::unique` A unique `email` field
- `joined:Joined On:date` A date field
- `active:Active:boolean` A boolean field

![Header types](./screenshots/column-types.png)

Only `field` is required — leave the rest blank to fall back to guessed
types. `flags` can be `unique` and/or `notnull`.

## The Import button

The header's **Import** button opens a dialog where you can:

- Paste a URL or upload a file.
- Pick from a few curated sample datasets to try the app out.
- Set a **row limit**, so a huge file doesn't have to load in full.
- Choose to edit columns before the import completes.

## Copy vs. Reference

When importing from a live source (like a [Datasette](https://datasette.io/)
instance), you choose:

- **Copy** (the default) — a normal table. Your data is saved locally and
  syncs like anything else; a **Refresh** button re-fetches the latest rows
  and merges them in, keeping any columns or edits you added.
- **Reference** — a live, read-only table. Rows are fetched from the source
  on demand and are never stored or synced — useful for data too large or
  too fast-changing to copy.

## Whole-workspace imports

Dropping a `.db.json` file (an export from easyDBAccess itself, see
[Sharing & Sync](sharing-and-sync.md)) restores an entire workspace — every
table, its rows, window positions, and views — in one go. You'll be asked
whether to merge it into your current workspace or replace everything.
