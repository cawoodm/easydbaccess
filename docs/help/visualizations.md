# Visualizations

A **visualization** is a picture of a table: a bar, column, line or pie chart,
a map of points, or a word cloud. It can sit in its own window, or be docked
**above** or **below** the grid inside the table's own window — so the numbers
and the picture move together.

A visualization is a kind of **View**, so everything Views already do applies:
templates are reusable, instances are bound to one table, and both travel with
your export and your sync.

## Making one

Open the **Views** icon in a table's toolbar and press **+ New chart**. Pick the
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

By default a chart **counts rows** per category, which works the moment you
pick a category. Choose a measure (sum, average, min, max, distinct count) when
you want the numbers to come from a column instead.

## Docked panes

A docked pane shares the grid's window and, importantly, the grid's **filters**:
type in a column funnel and the chart narrows with it. Drag the splitter to
resize the pane; the height is remembered. The strip along the top of a pane
has buttons to collapse it, refresh it, edit it, move it out into its own
window, or close it.

Minimizing the window puts the pane away with the grid, so a collapsed window
costs nothing.

## The buttons on a visualization

- **Refresh** re-reads the data. On an ordinary local table it redraws; on a
  table backed by a URL or a live database connection it re-fetches.
- **Edit** reopens the mapping and layout form.
- **Chart** opens the options for this kind — axis titles, the legend, marker
  size, the word rules.
- **CSV** saves the numbers behind the picture: the word counts, or the totals
  per category. They exist nowhere else, because they are worked out at drawing
  time.

## Word cloud rules

A cloud has three rules worth knowing about, all on the **Chart** form:

- **Ignore words shorter than** — 3 letters by default.
- **Always keep these words** — the exception to that limit _and_ to the ignore
  list, so `art`, `spa` or `AI` still count.
- **Ignore these common words** — a starting list of English filler words.
  Clear the box to count every word.

Options live in three layers: what you set in **Settings → Visualizations**
becomes the default for **new** clouds, a template carries its own values, and
an individual view can override any of them — an overridden field is marked as
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
