# Sharing & Sync

## Exporting

- **Per table:** the CSV button in a table's toolbar downloads just that
  table.
- **Whole workspace:** the footer **Export** button offers a JSON dump
  (`.db.json` — every table, its rows, and your window layout, in one file
  you can drop back in later to restore everything) or a SQL script.

## Backing up and moving between devices

There's no proprietary format — a `.db.json` file is plain JSON you can
version-control, email, or store anywhere. Drop it back onto the window to
restore it.

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
