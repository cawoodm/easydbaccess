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
- **A validation rule of your own** — see below.

## Writing your own validation rule

When the tick-boxes can't say it, a column can carry a small piece of
JavaScript that decides for itself. Open the column editor (the **Columns**
button in the window footer) and click the **pencil to the right of the Max
box**:

```js
function validate(value, row) {
  if (!/^[A-Z]{2}-\d{4}$/.test(value)) {
    throw new Error(`"${value}" doesn't match the required format (e.g. AB-1234).`);
  }
}
```

**Throwing rejects the edit**, and your message is exactly what the person
editing sees. Returning without throwing accepts it. `value` is what they just
typed and `row` is the rest of the row — including the pending change — so a
rule can compare columns ("end can't be before start").

Don't want to write one from scratch? The editor's **Start from a sample**
dropdown has ten ready-made rules — required, email, web address, a number
range, positive numbers, text length, a fixed list of values, a pattern, a
date that isn't in the future, and one column compared against another. Pick
one, adjust the value at the top of it, and save. Picked the wrong one? **Undo**
puts back what was there.

The rule runs on **manual edits only**. Importing, refreshing and syncing are
not edits, so a rule can't stop a table from loading — it tells you about the
next value someone types.

Validation is separate from the *other* pencil (the one left of Max), which
computes what a column **displays** — see
[Computing what a column shows](#computing-what-a-column-shows) below.

## Renderers — changing how a value is displayed

A column's **renderer** controls how its value is *shown*, separately from
its underlying type. The same number, date, or text column keeps sorting
and validating the same way no matter which renderer you pick — only the
display changes. Renderers are chosen in the column editor.

Plugins can change how data is rendered — for example as a clickable link:

![Rendering](./screenshots/plugin-renderer.png)

Or with a fully custom script that builds its own HTML from the row's data:

![Custom renderer](./screenshots/renderer-script.png)

### Computing what a column shows

The pencil **left of the Max box** opens the other script — the one that
decides what the column *displays*:

```js
function render(row) {
  return (Number(row.qty) * Number(row.price)).toFixed(2);
}
```

Whatever you return is handed to the column's renderer instead of the stored
value, so `link` can point at a computed URL and `html` can show text you
built. A computed cell is read-only, because there is nowhere to write an edit
back to.

This editor has its own **Start from a sample** dropdown, with ten scripts
covering what people actually ask a column for:

- **Text from other fields** — joining two columns into one.
- **Markdown** — `markdownToHtml(row.notes)` turns Markdown in a cell into
  formatted text. Pair it with the `html` renderer, or the cell shows the HTML
  source. It sanitises as it converts: formatting in your data survives, a
  `<script>` that arrived in a CSV doesn't.
- **URL building** — a link built from a field, one assembled with
  `URL`/`searchParams` (so spaces and `&` in the data can't break it), and a
  `mailto:` with a prefilled subject. Pair these with the `link` renderer.
- **Maths** — quantity × price, an amount as money via `Intl.NumberFormat`, a
  percentage that refuses to divide by zero, and days between a date and today.

Same **Undo** as the validation editor if you pick the wrong one. Each sample
says in its first line which renderer it expects — the dropdown can't set that
for you, it's the column's own Renderer box.

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
