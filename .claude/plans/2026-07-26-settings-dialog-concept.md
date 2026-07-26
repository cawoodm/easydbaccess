# Settings Dialog — Concept

**Status:** concept (design only; no code yet)
**Date:** 2026-07-26
**Scope:** A tabbed Settings dialog driven by a new `api.registerSettings`
plugin surface, with a two-layer (workspace / user) storage model.

## Goal

One dialog, opened from a header gear button, with:

- a **General** tab (placeholder for now — title only), then
- **one tab per plugin** that has registered settings.

Plugins declare their settings once; the dialog renders the controls, persists
edits, and lets the user choose whether each value lives with the **workspace**
(synced) or with the **user** (device-local, portable). This dogfoods the
plugin API: the Settings dialog itself is a built-in plugin, exactly like the
Plugin Manager button.

## The two-layer model

| Layer         | Stored in                                                     | Travels with                                              | Lifetime                      |
| ------------- | ------------------------------------------------------------- | --------------------------------------------------------- | ----------------------------- |
| **workspace** | `settings` Dexie table (`{key, value}`)                       | the workspace (already part of the gist/server sync blob) | per-workspace                 |
| **user**      | `localStorage['/easydbaccess/settings.json']` — one JSON blob | the device; user exports/imports the blob to move it      | cross-workspace, device-local |

**Key convention (both layers):** `"<pluginId>:<key>"`, e.g. `server-sync:url`.
This matches today's `settings` keys (`server-sync:url`), so no data migration
is needed — existing workspace settings simply _are_ the workspace layer.

**Read resolution:** `user` layer wins over `workspace` layer. A value present
in `/easydbaccess/settings.json` shadows the same key in the `settings` table.

## Plugin API

### Declaring settings — `api.ui.registerSettings`

Typed field array (chosen over twikki's `~`-descriptor JSON for type-safety and
clarity):

```ts
api.ui.registerSettings('server-sync', 'Server Sync', [
  {
    key: 'url',
    label: 'Server URL',
    type: 'string',
    scope: 'workspace',
    description: 'Base URL of the sync server',
  },
  { key: 'token', label: 'Token', type: 'secret', scope: 'user' },
  { key: 'interval', label: 'Poll (s)', type: 'number', default: 60 },
]);
```

New contract types in `packages/shared/src/plugin-api.ts`:

```ts
export type SettingScope = 'workspace' | 'user';

export interface SettingsFieldSpec {
  key: string; // stored as `${pluginId}:${key}`
  label: string;
  type: 'string' | 'text' | 'number' | 'boolean' | 'date' | 'secret' | 'option' | 'selection';
  default?: unknown;
  options?: string[]; // for 'option' (radio) / 'selection' (checkboxes)
  description?: string; // shown as field help
  scope?: SettingScope; // DEFAULT layer; user may toggle. Omitted ⇒ 'workspace'
}

export interface UiRegistry {
  // …existing…
  /** Registers a plugin's settings tab. Returns an unregister fn. */
  registerSettings(pluginId: string, name: string, fields: SettingsFieldSpec[]): Unregister;
}
```

Field types reuse the twikki vocabulary minus `json`/nested sections (YAGNI for
v1). Controls map: `string→text input`, `text→textarea`, `number→number input`,
`boolean→checkbox`, `date→date input`, `secret→text input`,
`option→radio group`, `selection→checkbox group`.

### Reading/writing settings — `api.settings`

Plugins need a layer-aware accessor. New surface on `HostApi`:

```ts
export interface SettingsApi {
  /** Resolved value: user layer wins over workspace, else the field default. */
  get<T = unknown>(pluginId: string, key: string): Promise<T | undefined>;
  /** Writes to `scope` (defaults to the field's declared/placed scope). */
  set(pluginId: string, key: string, value: unknown, scope?: SettingScope): Promise<void>;
  /** Which layer currently holds the key ('user' | 'workspace' | null). */
  placement(pluginId: string, key: string): Promise<SettingScope | null>;
}
interface HostApi {
  /* … */ settings: SettingsApi;
}
```

**Back-compat:** the workspace layer is still the `settings` table with the same
keys, so existing direct reads (`store.settings.findOne('server-sync:url')`)
keep working — they just only see the _workspace_ layer. Consumers migrate to
`api.settings.get('server-sync','url')` to honour a user-scoped override. The
`api-factory` `readServerBaseUrl` helper and each sync plugin migrate as part of
implementation.

## Storage internals

- **Workspace layer:** unchanged — `store.settings` (`{key, value}`), keyed
  `pluginId:key`. Already synced.
- **User layer:** a tiny module `db/user-settings.ts` wrapping
  `localStorage['/easydbaccess/settings.json']` as `Record<string, unknown>` keyed the
  same way. Pure functions (`readUserSettings`, `writeUserSetting`,
  `removeUserSetting`, `exportBlob`, `importBlob`) so it's unit-testable without
  a DOM by injecting a storage shim.
- The `SettingsApi` resolver composes the two: `get` reads user blob first, then
  the `settings` table, then the registered field default.

No new Dexie collection and no schema-version bump (settings table already
exists).

## The dialog (renderer)

- New Lit element `dialogs/settings-dialog.ts`, following
  `plugin-manager-dialog.ts` conventions (`dialogChromeStyles`,
  `makeDialogDraggable`, `materialIconStyles`, `showModal()`).
- **Tabs:** a left/top tab strip — `General` first, then one per entry in the
  settings registry (`{pluginId → {name, fields}}`), rendered in registration
  order.
- **Per field row:** label + help, the control, and a small `☐ user` checkbox
  that promotes/demotes the value between layers (keeps the current value; the
  resolver de-dupes the other layer). Mirrors the twikki reference.
- **General tab (v1):** placeholder — heading + short blurb only. (Workspace
  rename / theme / raw-JSON editor are noted as follow-ups, not built now.)
- **Live save:** `change` events write immediately via `api.settings.set` (no
  explicit Save button), matching the Plugin Manager's inline-apply feel.
- Settings marked as secret have a helper icon on the right which allows selection of a secret from secrets.txt

## Registry + trigger

- New registry slice `registries.settings: Map<string, {name, fields}>` in
  `plugin-host/registries.ts`, append-only like the other slots; the dialog
  re-snapshots it on `app:ready` so hot-loaded plugins' tabs appear without a
  reload.
- New built-in plugin `plugins/settings.ts` (`meta.name = 'settings'`): registers
  a header button (gear icon) that opens `<settings-dialog>`, and owns the
  General tab content. Added to the `builtins` array in `loader.ts`.

## Secrets

Secrets are stored in /easydbaccess/secrets.txt and are cross-workspace
The settings dialog allows editing of this in a textarea
Settings can reference secrets as in twikki (${secret:githubPAT})
Dragging in a file /easydbaccess/secrets.txt is supported by a core plugin
Example secrets:

```
githubPAT: abc...
gitPAT: abc...
mypassword: test123
```

## Migrating existing plugins (implementation phase)

Each calls `registerSettings` and switches reads to `api.settings.get`:

- `server-sync` — `url` (workspace), `token`/PAT (user).
- `gist-sync` — gist id + PAT (user scope — credentials are device-local).
- `auto-sync` — interval / enabled flags.
- `datasette-source` — any thresholds / connection refs.

Workspace-layer keys are unchanged, so this is additive — no data migration.

## Non-goals (v1 / YAGNI)

- Nested setting sections / sub-groups (twikki supports; defer).
- Live cross-field validation.
- Theme system / workspace-management controls in General (follow-ups).

## Testing

- **Unit:** the `SettingsApi` resolver (user-over-workspace precedence, default
  fallback), `user-settings.ts` (read/write/export/import round-trip),
  field→control mapping.
- **e2e:** open dialog → edit a workspace field → reload → value persists; toggle
  a field to `user` → it lands in `/easydbaccess/settings.json` and survives a workspace
  switch.

## Lockstep checklist (for the implementation task)

1. `packages/shared/src/plugin-api.ts` — `SettingsFieldSpec`, `SettingScope`,
   `SettingsApi`, `UiRegistry.registerSettings`, `HostApi.settings`.
2. `renderer/src/plugin-host/registries.ts` — `settings` slice + `registerSettings`.
3. `renderer/src/plugin-host/api-factory.ts` — build `api.settings` resolver.
4. `renderer/src/db/user-settings.ts` — localStorage blob helpers (new).
5. `renderer/src/dialogs/settings-dialog.ts` — the Lit dialog (new).
6. `renderer/src/plugins/settings.ts` — built-in plugin + header button (new);
   register in `loader.ts`.
7. Migrate `server-sync` / `gist-sync` / `auto-sync` / `datasette` to
   `registerSettings` + `api.settings.get`.
