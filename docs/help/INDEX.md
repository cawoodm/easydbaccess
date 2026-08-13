# User Guide

easyDBAccess is a small personal database that runs in your browser (or as a
desktop app). This guide explains what you can do with it. For how it's
built, see the [developer docs](../tech/INDEX.md) instead.

![Overview](./screenshots/overview.png)

## Guide

- [Getting Started](getting-started.md) — what it is, and your first table
- [Importing Data](importing-data.md) — CSV, JSON, and other sources
- [Tables and Windows](tables-and-windows.md) — arranging, resizing, the
  Command Palette
- [Sorting, Filtering & Search](sorting-filtering-search.md)
- [Editing Cells & Renderers](editing-cells.md) — links, images, colors,
  HTML, custom renderers
- [Views](views.md) — read-only, styled layouts of your data
- [Visualizations](visualizations.md) — charts, maps and word clouds, in a
  window or docked to the grid
- [Database Files](database-files.md) — keep a workspace in a real SQLite file:
  `.db` on the desktop, `.edb` in a browser
- [Sharing & Sync](sharing-and-sync.md) — export, your own server, GitHub
  Gist
- [Commandlets](commandlets.md) — `goto/bible?Book=Matthew` as a link, a
  `#hash`, or a palette entry
- [Settings](settings.md) — fields, workspace vs. device scope, secrets
- [Settings & Plugins](settings-and-plugins.md) — configuration, secrets,
  extending the app

## The short version

- Drag a CSV or JSON file onto the window and it becomes a table.
- Click a column header to sort, click the funnel icon to filter.
- Everything is saved automatically on your device — no account needed.
- Sync between devices with a private GitHub Gist, or your own small server.
- Add features by pasting a plugin URL — no install required.
