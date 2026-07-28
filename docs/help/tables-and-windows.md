# Tables and Windows

Each table (and each [view](views.md)) opens in its own floating window,
like a document on a desktop. You can drag, resize, minimize, and maximize
these windows freely.

## Moving and resizing

- **Drag** a window by its title bar to move it anywhere.
- **Resize** by dragging any edge or corner.
- **Minimize** collapses a window to save space — its data stops loading
  in the background until you expand it again, so a minimized table doesn't
  slow down the rest of your workspace.
- **Maximize** fills the screen; double-clicking the title bar also toggles
  maximize/restore.
- Positions, sizes, and minimized/maximized state are all remembered — close
  the tab and reopen it, and your windows come back exactly as you left
  them, including which one was on top.

## Panning and zooming your workspace

If you have many windows, or one has drifted off-screen, the whole canvas
can be panned and zoomed:

- **On a touchscreen:** one finger drags the empty background to pan; two
  fingers pinch to zoom; double-tap resets to normal.
- **On a desktop:** hold the right mouse button and drag anywhere on the
  empty background to pan.

## Closing vs. deleting a table

Closing a table's window only **hides** it — your data is untouched, and you
can bring it back any time from the [Command Palette](#command-palette)
(search for "Go to `<table name>`"). To permanently delete a table and its
data, use the trash icon in that table's own toolbar.

## The Command Palette

Press **Ctrl+K** (or **Cmd+K** on a Mac) anywhere in the app to open the
Command Palette — a searchable list of everything you can do:

- Jump straight to any table or view.
- Run any header/footer button (Import, Export, Sync, Settings, …) without
  hunting for it.
- Run window commands: minimize/restore/maximize all, cascade, tile, or
  close everything at once.

Type to filter, use the arrow keys to move, **Enter** to run, and **Esc** to
close.

## Renaming a table

A table's title bar can show a friendlier name than its technical one — set
it from the column editor (the icon in the table's toolbar). Exports and
sync still use the technical name underneath.
