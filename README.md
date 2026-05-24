# easyDBAccess

**Your data, in your browser. No servers, no signup, no spreadsheets.**

easyDBAccess is a small personal database that runs entirely in your browser
(or as a desktop app). Drop in a CSV, get a real table you can sort, filter,
edit, and export — with every change saved locally and ready to sync to your
other devices when you want it to.

It's the successor to [minniDBMax](https://github.com/cawoodm/minniDBMax),
rebuilt to be faster, larger-capacity, and extensible through plugins.

> Try it now: <https://cawoodm.github.io/easydbaccess/>

![Overview](./docs/screenshots/overview.png)

---

## Highlights

- **Drag-and-drop a CSV or JSON file** and you have a working, sortable,
  filterable table — no setup, no schema dialogs.
- **Multiple tables in one workspace**, each in its own draggable window.
  Arrange them like sticky notes on a desk.
- **Local-first.** Everything lives in your browser (or a SQLite file on
  desktop). Works offline. No account required.
- **Smart column types.** Numbers sort numerically, dates sort
  chronologically, colours render as swatches, image data renders as images,
  URLs and phone numbers become clickable links.
- **Per-column filters with autocomplete** — pick from the values that
  actually exist in the column, with faceted drill-down across filters.
- **Sync between devices** through a tiny optional server, or via a
  private GitHub Gist. Bring your own backend or use none.
- **Plugins are just `.js` files.** Add a button, a new cell renderer, an
  import format, or a whole view — by pasting a URL.
- **Runs anywhere:** browser tab, or installable desktop app (Windows / Mac /
  Linux) with native SQLite storage.

---

## What you can do with it

### Import a CSV in two seconds

Drop a file on the window. The first row becomes columns; types are inferred
from the data (number, date, boolean, string).

![Import CSV](./docs/screenshots/import-csv.png)

You can also start with just a header line to define your columns up front,
using a tiny inline mini-language for labels, types, defaults, and
constraints:

```
id:ID:number::unique,notnull
name:Full Name:string:::
email:Email:string::unique
joined:Joined On:date::
active:Active:boolean::
```

![Header types](./docs/screenshots/column-types.png)

### Sort and filter

Click a column header to sort. Numbers stay numbers (so `10` comes after
`2`), dates stay dates. Click the filter icon to filter by value with
autocomplete, or type a substring.

![Sorting](./docs/screenshots/sorting.png)
![Filtering](./docs/screenshots/filter.png)

Plugins can change the way data is rendered, for example as a hyperlink:
![Rendering](./docs/screenshots/plugin-renderer.png)

### Export anywhere

Each table can be exported as CSV. The whole workspace can be exported as a
single `.db.json` file — drop it back in to restore everything (tables,
window positions, column settings).

### Sync to your other devices (optional)

Two flavours, pick one — or neither:

- **Your own tiny server.** Run the bundled Hono server on a Raspberry Pi,
  Render, Fly, anywhere. Click **Sync ↑** to push, **Sync ↓** to pull.
  See [`docs/SYNCH.md`](./docs/SYNCH.md) for the details.
- **A private GitHub Gist.** No server needed — your workspace is the gist.

---

## How it stores your data

| Where it runs | Where data lives |
|---|---|
| Browser | IndexedDB (via RxDB) |
| Desktop (Electron) | A real SQLite file on disk |
| Server (optional, for sync) | One JSON-per-workspace, in a folder or SQLite |

You can copy, back up, or version-control the data files yourself. There is
no proprietary format — JSON in, JSON out.

---

## Extending it (plugins)

Everything you see in the app — CSV import, JSON import, the table view,
the colour-swatch cells, the sync buttons — is a plugin. They all use the
same `HostApi` that you can use to build your own.

A plugin is a single ES module:

```js
export const meta = { name: 'my-plugin', version: '0.0.1' };

export function load(api) {
  api.ui.registerHeaderButton({
    id: 'my-plugin:hello',
    label: 'Hello',
    onClick: () => alert('hi from a plugin'),
  });
}
```

Drop the URL into the Plugin Manager and the host fetches it, caches it
locally, and loads it on next startup. Plugin URLs travel with your
workspace, so they show up on your other devices too.

The full API contract lives in
[`packages/shared/src/plugin-api.ts`](./packages/shared/src/plugin-api.ts).
A few reference plugins live in
[`packages/renderer/src/plugins/`](./packages/renderer/src/plugins/).

---

## Running it locally

You need Node 20+.

```bash
npm install
npm run dev:renderer       # browser app at http://localhost:5190
npm run dev:server         # sync server at http://localhost:3000
npm run dev:electron       # desktop shell
```

To produce a desktop installer:

```bash
npm run package:electron
```

See [`CLAUDE.md`](./CLAUDE.md) for the developer-facing architecture overview
and [`.claude/plans/2026-05-21-rewrite-architecture.md`](./.claude/plans/2026-05-21-rewrite-architecture.md)
for the full design.

---

## Status

Active rewrite. The browser app and sync server are working today; the
Electron shell with native SQLite storage and the URL-loaded plugin manager
are the next milestones. Track progress in [`TODO.md`](./TODO.md).

## Project layout

```
packages/shared/    types, schemas, plugin API contract
packages/renderer/  the Lit-based UI (browser + Electron renderer)
packages/server/    the Hono sync server (also embedded in Electron)
packages/electron/  the desktop shell
plugins-examples/   reference plugins
docs/               architecture notes (incl. SYNCH.md)
```

## Credits

Built by [Marc Cawood](https://github.com/cawoodm). Successor to
[minniDBMax](https://github.com/cawoodm/minniDBMax). MIT licensed.
