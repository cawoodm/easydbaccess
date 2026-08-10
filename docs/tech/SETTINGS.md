# Settings

How a plugin declares configuration, where the values end up on disk, and
the `${secret:name}` mechanism that keeps tokens out of synced data. The
contract lives in
[`plugin-api.ts`](../../packages/shared/src/plugin-api.ts)'s Settings
section; the dialog that edits these values is covered in
[`DIALOGS.md`](./DIALOGS.md)'s "The Settings dialog" section, and the
two-layer storage model is summarized in `STORAGE.md`'s settings section.
This page is the plugin-author's view: how to declare a field and read it
back.

## Registering a settings tab

```ts
api.ui.registerSettings(pluginId: string, name: string, fields: SettingsFieldSpec[]): Unregister
```

- `pluginId` — the tab's identifier. By convention this is the plugin's own
  `meta.id` (`gist-sync`, `server-sync`, `preview`), but it's a free-form
  string, not a lookup into the plugin registry — see "A tab id need not be a
  real plugin id" below.
- `name` — the tab's display label in the Settings dialog nav.
- `fields` — the field specs for this tab, rendered top to bottom.

Calling it again with the same `pluginId` just overwrites the map entry
(`registries.ts`), so re-registering identical fields — e.g. from two
different plugins that share one tab — is a harmless no-op regardless of
load order.

## Field types (`SettingsFieldSpec`)

```ts
interface SettingsFieldSpec {
  key: string;
  label: string;
  type: SettingsFieldType; // 'string' | 'text' | 'number' | 'boolean' | 'date' | 'secret' | 'option' | 'selection'
  default?: unknown;
  options?: string[]; // for 'option' and 'selection'
  description?: string; // shown as help text under the control
  scope?: SettingScope; // 'workspace' | 'user' — the DEFAULT layer; omitted ⇒ workspace
}
```

The dialog's `renderControl()` switch maps each `type` to a control:

| Type        | Control                                                            |
| ----------- | ------------------------------------------------------------------ |
| `string`    | single-line text input                                             |
| `text`      | multi-line textarea                                                |
| `number`    | numeric input; clearing it stores `undefined`, not `0`             |
| `boolean`   | checkbox                                                           |
| `date`      | native `<input type="date">`                                       |
| `secret`    | text input + a "insert secret reference" `<select>` of known names |
| `option`    | radio group over `options`                                         |
| `selection` | checkbox group over `options`, value is `string[]`                 |

A `secret`-typed field gets extra validation in the dialog: a non-empty value
that isn't a `${secret:name}` reference is flagged (red border) and blocks
the dialog from closing until it's moved into the secrets store — see
[`../help/settings.md`](../help/settings.md) for the user-facing behavior.

## Reading a value: `api.settings.get`

```ts
get<T = unknown>(pluginId: string, key: string): Promise<T | undefined>
```

Resolution order (`createSettingsApi` in
[`api-factory.ts`](../../packages/renderer/src/plugin-host/api-factory.ts)):

1. **User layer** — if the key exists in the device-local `localStorage`
   blob, that value wins outright.
2. **Workspace layer** — else, the matching row in the Dexie `settings`
   collection, if one exists.
3. **Field default** — else, the registered field's `default`.

If the resolved value is a string, it's passed through `interpolateSecrets()`
before being returned, so a value like `${secret:githubPAT}` comes back as
the actual token.

## Writing a value: `api.settings.set` / `placement`

```ts
set(pluginId: string, key: string, value: unknown, scope?: SettingScope): Promise<void>
placement(pluginId: string, key: string): Promise<SettingScope | null>
```

`set` writes to `scope` if given, else the field's declared `scope`, else
`'workspace'`. A key lives in **exactly one layer at a time** — writing to
`'user'` removes the workspace row for that key, and vice versa, so toggling
a field's scope in the dialog is a move, not a copy.

`placement` reports which layer currently holds a key (`'user'`,
`'workspace'`, or `null` if neither — meaning the field default is in
effect).

### `set` will not overwrite a reference with its own secret

Because `get` resolves `${secret:name}`, a plugin that reads a setting, changes
something else and writes it back hands `set` the SECRET where the reference used
to be — and the secret then syncs. gist-sync did this when it saved the id of a
newly created gist alongside the credentials it had just read, which is how a
`${secret:...}` field appeared to "reset itself to the resolved value".

So `set` compares the incoming string with the resolved form of what is already
stored (`resolvesToSameSecret` in
[`db/secret-guard.ts`](../../packages/renderer/src/db/secret-guard.ts)) and keeps
the reference instead of writing. Pointing the field at another secret, clearing
it, or writing any other value all go through as normal. A literal value that
happens to equal the secret is indistinguishable from the accident and is refused
too — the safe way round, since the dialog does not accept a raw secret in a
`secret` field either.

The push side has the matching net: `withoutRawSecrets()` withholds any setting
that holds a credential rather than a reference, so one that got in by some other
road still never leaves the device (see `PLUGINS.md`'s gist-sync section).

## Key format and where each layer persists

Every setting is addressed as `${pluginId}:${key}` — e.g. `gist-sync:gist_token`,
`preview:maxChars`, `datasette:maxImportRows`.

- **Workspace layer** — the Dexie `settings` table
  ([`dexie-db.ts`](../../packages/renderer/src/db/dexie-db.ts)). The physical
  primary key is `<workspaceId>::<pluginId>:<key>` (see the `Setting` type
  in [`types.ts`](../../packages/shared/src/types.ts) and `settingId()` /
  `settingsView()` in
  [`data-store-dexie.ts`](../../packages/renderer/src/db/data-store-dexie.ts)),
  but plugins never build that key themselves — `store.settings` and
  `api.settings` both scope automatically to the active workspace. This
  layer travels with the workspace: it's included in JSON dump export,
  gist-sync's push/pull, and server-sync's whole-workspace push/pull.
- **User layer** — a single JSON blob in `localStorage` at
  `/easydbaccess/settings.json`
  ([`user-settings.ts`](../../packages/renderer/src/db/user-settings.ts),
  `readUserSetting`/`writeUserSetting`/`removeUserSetting`). Device-local,
  never synced, never exported.

## A tab id need not be a real plugin id

`registerSettings`'s first argument is just a map key, not a lookup against
the plugin registry. [`datasette-common.ts`](../../packages/renderer/src/plugins/datasette-common.ts)
uses this: both the `datasette-import` and `datasette-connect` plugins call
`registerDatasetteSettings(api)`, which registers one shared "Datasette" tab
under the free-form id `DATASETTE_SETTINGS_ID = 'datasette'` (not either
plugin's own `meta.id`), with fields `maxImportRows` (0 = unlimited),
`pageSize`, `connectMaxRows`, `retryWaitSeconds`. Whichever plugin's `init()`
runs first "wins" the registration; it doesn't matter which, since both pass
identical field specs, and both read the same resolved `datasette:*` keys
afterward.

## Telling a reader a setting changed

There is no live query over settings. A collection has one (a grid re-runs its
row query on any write), but `api.settings.get` resolves through the user layer,
the workspace layer, the field default and the secrets store, so a component
either re-reads on every use or caches a value that goes stale the moment
someone flips it in the dialog.

`db/settings-events.ts` is the seam: the Settings dialog raises
`easydb:settings-changed` with `{ pluginId, key }` after each auto-save, and a
listener that cares re-reads what it needs. The event carries no VALUE, so the
store stays the one source of truth.

Which of the two a reader wants depends on when it needs the answer:

- **Per use** — `readSortDescFirst` runs inside the header-click handler. A click
  is not a hot path, and reading it there means there is nothing to invalidate.
- **Into state** — `readHighlightNulls` is needed while painting every cell, and
  a render cannot await a store read. `<data-table>` reads it on mount and again
  on the event, so the switch repaints the open grids instead of waiting for a
  reload.

Both live in [`table/grid-settings.ts`](../../packages/renderer/src/table/grid-settings.ts),
which exists because of the direction the dependencies must run: the `settings`
plugin REGISTERS the `grid` fields and `<data-table>` READS them, and neither may
import the other.

## Secrets: `${secret:name}` references

A separate, cross-workspace, device-local store — a `name: value` text blob
at `localStorage['/easydbaccess/secrets.txt']`
([`user-settings.ts`](../../packages/renderer/src/db/user-settings.ts),
`parseSecrets`/`readSecretsText`/`writeSecretsText`). Blank lines and `#`
comments are ignored.

Any **string** setting value, in any field (not just `secret`-typed ones),
may embed `${secret:name}`. `interpolateSecrets()` substitutes it on every
`api.settings.get()` call; an unknown name is left as the literal
`${secret:name}` text rather than silently becoming empty, so a missing
secret fails loudly (a bad request) rather than quietly.

This is why `gist-sync`'s GitHub token (`gist_token`, `type: 'secret'`)
defaults to `scope: 'user'` — the value the field holds is normally a
`${secret:...}` reference, and the reference itself is device-local, so the
actual token underneath it never gets swept into a workspace export or a
pushed gist. Nothing in the settings API enforces this pattern — a plugin
can still register a `'string'` field at `scope: 'workspace'` and let a user
paste a raw token into it — the Settings dialog only blocks a raw value on
fields explicitly typed `'secret'`.

## Recipe: add a setting to your plugin

Modeled on [`preview.ts`](../../packages/renderer/src/plugins/preview.ts),
which caches the resolved value in a module-level variable for cheap reads
from a hot rendering path, refreshing it at `init()` and again on `app:ready`:

```ts
let maxChars = 30;

async function refreshMaxChars(api: HostApi): Promise<void> {
  const v = await api.settings.get<number>('preview', 'maxChars');
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) maxChars = Math.floor(v);
}

export function init(api: HostApi): void {
  api.ui.registerSettings('preview', 'Preview', [
    {
      key: 'maxChars',
      label: 'Max characters shown',
      type: 'number',
      default: 30,
      scope: 'workspace',
      description: 'HTML-preview cells show the first N characters of the text.',
    },
  ]);
  void refreshMaxChars(api);
  api.events.on('app:ready', () => void refreshMaxChars(api));
}
```

Note the tradeoff this pattern accepts: `maxChars` only refreshes at boot and
on `app:ready` (a plugin (re)install), not the instant the user edits the
field in the dialog — the field's own doc string says as much ("Applies to
cells rendered after the change (reload to refresh all)"). If your plugin
needs a setting to take effect immediately, call `api.settings.get()` at the
point of use instead of caching it, or re-read it from your own UI's change
handler.

For a setting whose value should hold a token, register it `type: 'secret'`
and default it to `scope: 'user'` — see `gist-sync.ts`'s `gist_token` field
for the pattern.
