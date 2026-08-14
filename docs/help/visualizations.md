# Visualizations

A **visualization** is a picture of a table: a bar, column, line or pie chart,
a map of points, a word cloud, or a block of your own HTML. It can sit in its
own window, or be docked
**above** or **below** the grid inside the table's own window — so the numbers
and the picture move together.

A visualization is a kind of **View**, so everything Views already do applies:
templates are reusable, instances are bound to one table, and both travel with
your export and your sync.

## Making one

Open the **Views** icon in a table's toolbar and press **+ New visualization**. Pick the
kind, then map your columns to the chart's inputs — a bar chart wants a
_Category_ to group by, a map wants _Latitude_ and _Longitude_, a word cloud
wants one text column. When you press **Use**, the "Show it" choice decides
whether the chart opens in its own window or docks above or below the grid.

Changing that choice later takes effect immediately: a window becomes a pane,
or a pane becomes a window, the moment you save.

## The kinds

| Kind                    | Reads                                     | Good for                                  |
| ----------------------- | ----------------------------------------- | ----------------------------------------- |
| Bar / Column            | a category, optionally a value and series | counts and totals per group               |
| Line                    | an X axis (often a date), a value         | a trend over time                         |
| Pie                     | a category, a value                       | shares of a whole                         |
| Map                     | latitude, longitude, optional label/size  | anything with coordinates                 |
| Word cloud              | one text column                           | what a column of prose actually talks about |
| Custom HTML             | nothing — your markup names its own columns | a KPI tile, a row of filter pills, a summary line |

By default a chart **counts rows** per category, which works the moment you
pick a category. Choose a measure — sum, average, minimum, maximum or distinct
count — when you want the numbers to come from a column instead.

The measure lives in two places on purpose. Set it under **Edit** and every view
of that chart uses it; set it under **Settings** and only that one view does,
while the rest keep following the definition. The same is true of the order and
the group cap. An overridden field is marked, and **Reset** puts it back to
following.

## Docked panes

A docked pane shares the grid's window and, importantly, the grid's **filters**:
type in a column funnel and the chart narrows with it. Drag the splitter to
resize the pane; the height is remembered. The strip along the top of a pane
has buttons to collapse it, open its definition (`<>`) or its
**Settings**, refresh it, move it out into its own window, or close it.

Minimizing the window puts the pane away with the grid, so a collapsed window
costs nothing.

## The buttons on a visualization

- **Refresh** re-reads the data. On an ordinary local table it redraws; on a
  table backed by a URL or a live database connection it re-fetches.
- **Edit** opens the **definition** — the kind, the aggregate and the options
  every view of it shares.
- **Settings** opens **this view** — its column mapping, its row limit, and any
  option it overrides. Anything you change here applies to this view only;
  anything you leave alone keeps following the definition.
- **CSV** saves the numbers behind the picture: the word counts, or the totals
  per category. They exist nowhere else, because they are worked out at drawing
  time.

## Custom HTML

When none of the kinds above is what you want, **Custom HTML** lets you write
the pane yourself. There is nothing to map: your markup names the columns it
reads.

Press the **✏** beside the HTML box to open the editor, and start from a
sample — there are six, and each one draws something the moment you pick it.
Editing a sample usually means changing a field name in it.

The tokens describe the **whole set the grid is showing**, not one row:

| Token             | Shows                                          |
| ----------------- | ---------------------------------------------- |
| `$COUNT`          | how many rows are on screen                    |
| `$COUNT.field`    | how many of them have a value in that column   |
| `$SUM.field`      | the total                                      |
| `$AVG.field`      | the average                                    |
| `$MIN.field` / `$MAX.field` | the extremes                         |
| `$DISTINCT.field` | how many different values the column holds     |
| `$filter.field`   | one clickable pill per distinct value          |

Anything that is not one of these is left exactly as you wrote it, so a `$` in
your CSS is safe — and a mistyped token stays visible instead of vanishing.

### Links that act on the table

A link whose `href` starts with `#goto` and names **no table** acts on the table
the visualization is about — so the same block of markup works on any table you
drop it on:

```html
<a href="#goto?country==CH">Only CH</a>
<a href="#goto?@sort=-amount">Biggest first</a>
<a href="#goto?@search=berlin">Search “berlin”</a>
<a href="#goto?@clear&amp;@search=">Reset</a>
```

These are **commandlets**, the same little URLs the command palette runs, so
everything they can do elsewhere they can do here. Write `&amp;` rather than a
bare `&` when you chain two — it is HTML. The **Toolbar** sample has one of each.

Clicking a `$filter.` pill **narrows the grid the pane is docked to**. A
visualization is a two-way street: it draws what the grid is showing, and it can
change what that is. The filter is the grid's own, so its column funnel is where
you see it and where you clear it again.

The **Script** box is optional and only for what markup cannot do. It defines
`render(rows, api)`, runs once per draw after the HTML is in place, and either
returns a string or builds elements in `api.el`. `api.filter(field, value)` and
`api.sort(field)` are the same requests a pill makes. A script that throws shows
its message in the pane rather than leaving it blank.

> **A word about trust.** A custom visualization's script runs in the page, with
> the same reach a column script has. A workspace you were sent, synced or
> imported can therefore carry a script that runs when you open it. That has
> always been true of column scripts and view templates; it is worth knowing.

## Word cloud rules

A cloud has three rules worth knowing about, all on the **Edit** form:

- **Ignore words shorter than** — 3 letters by default.
- **Always keep these words** — the exception to that limit _and_ to the ignore
  list, so `art`, `spa` or `AI` still count.
- **Ignore these common words** — a starting list of English filler words.
  Clear the box to count every word.

Options live in three layers: what you set in the app's **Settings →
Visualizations** becomes the default for **new** clouds, the definition (**Edit**)
carries its own values, and an individual view (**Settings**) can override any of
them — an overridden field is marked as
such on the form, and **Reset** puts it back to the template's value.

## Big tables

Aggregation happens in the app over the rows it has read. When that is not all
of them, the pane says so underneath the chart ("first N of M"). The same goes
for values it could not read as numbers: they are counted and reported rather
than quietly treated as zero, because a bar that is short for that reason looks
exactly like a bar that is genuinely short.

## Something to try it on

`docs/help/workspace.db.json` in this repository is a small demo workspace —
48 city trips with coordinates, dates, ratings and a sentence of prose each.
Drag the file onto the app and it arrives with every kind above already set up:
a word cloud docked over the grid, a bar chart docked under it, and a map, a
column chart, a line, a pie and a second word cloud (with overridden word
rules) in their own windows.

It adds a `Trips` table alongside whatever you already have, so it is safe to
drop into a workspace you are using.
