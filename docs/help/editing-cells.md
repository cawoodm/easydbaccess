# Editing Cells & Renderers

## Editing a cell

Click any cell to edit it. Checkboxes for booleans, date pickers for dates,
and a plain text/number box otherwise. Press **Esc** while editing to cancel
and revert to the stored value.

A column can enforce rules, and a bad edit is rejected with a message
explaining why, rather than silently discarded:

- **Required** — the cell can't be left empty.
- **Max length/value** — a string or number can't exceed a limit.
- **Unique** — the value can't already exist elsewhere in the column.

## Renderers — changing how a value is displayed

A column's **renderer** controls how its value is *shown*, separately from
its underlying type. The same number, date, or text column keeps sorting
and validating the same way no matter which renderer you pick — only the
display changes. Renderers are chosen in the column editor.

Plugins can change how data is rendered — for example as a clickable link:

![Rendering](./screenshots/plugin-renderer.png)

Or with a fully custom script that builds its own HTML from the row's data:

![Custom renderer](./screenshots/renderer-script.png)

### Built-in renderers

| Renderer | What it shows |
|---|---|
| **Link** | Detects URLs, email addresses, and phone numbers and turns them into clickable links. A pencil icon lets you switch to editing the raw text. |
| **Color** | A color swatch and picker for hex color values. |
| **Image** | A thumbnail with an upload button; images are stored directly in the cell. |
| **HTML (preview)** | Shows the plain text of an HTML value, trimmed to a short length, with a popup icon to view the full rendered HTML. |
| **HTML (render)** | Renders the HTML directly in the cell, and lets you edit it inline. |
| **Script** | Runs a small script you write to build the cell's HTML from the whole row — for fully custom layouts. |

## Column types still matter

Even with a custom renderer, a column's underlying **type** (number, date,
text, boolean) still decides how it sorts and what counts as a valid edit.
The renderer only changes what you see.
