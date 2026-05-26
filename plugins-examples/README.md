# plugin examples

Reference plugins for easyDBAccess. Each is a single ES module `.js` file with
this shape:

```js
export const meta = {
  name: 'my-plugin',
  version: '0.0.1',
  description: 'what it does',
  author: 'you',
};

export function init(api) {
  // called once at startup, before the app is ready
}

export function load(api) {
  // called once when the app is ready (DB + workspace loaded)
  api.ui.registerHeaderButton({
    id: 'my-plugin:hello',
    label: 'Hello',
    onClick: () => alert('hi'),
  });
}
```

The full `api` (HostApi) contract lives in
[`packages/shared/src/plugin-api.ts`](../packages/shared/src/plugin-api.ts).

Plugins are loaded by URL — drop a URL into the Plugin Manager dialog and the
host fetches it, caches the body in localStorage, and `import()`s it on
startup. The plugin URL list is part of the workspace, so it syncs across
devices.

> Note: the URL-load path is not yet wired (planned slice). Today, built-in
> plugins are imported statically by the renderer's plugin host
> ([`packages/renderer/src/plugin-host/loader.ts`](../packages/renderer/src/plugin-host/loader.ts)).
> Third-party URL loading lands once the Plugin Manager dialog is built.

## Shipped built-ins

These live as TS modules under `packages/renderer/src/plugins/` and load on
startup. Each conforms to the same `PluginModule` shape that URL-loaded
plugins must follow — they only use `HostApi`, no `dexie` imports.

- **csv-import** ([source](../packages/renderer/src/plugins/csv-import.ts))
  — drag-drop `.csv` files. Auto-detects separator (`,`/`;`/`\t`), parses
  RFC-4180 quoting, infers column types from values (`number` → `boolean`
  → `date` → `string`).
- **json-import** ([source](../packages/renderer/src/plugins/json-import.ts))
  — drag-drop `.json` / `.db.json`. Recognises two shapes:
    1. **Native multi-table dump** — `{ tables: [{ name, columns, rows }, ...] }`
    2. **Array of objects** — `[{...}, ...]` becomes a single table; columns
       come from the union of object keys; types inferred from values.

## Planned reference plugins (not built yet)

- `markdown-export.js` — export a table as a Markdown table
- `kanban-view.js` — register a `kanban` table renderer
- `color-cell.js` — register a `color` cell renderer (swatch + picker)
- `image-cell.js` — register an `image` cell renderer (data URI + uploads)
- `github-url-source.js` — import rows from a GitHub gist or repo file
- `header-clock.js` — trivial header-button example
