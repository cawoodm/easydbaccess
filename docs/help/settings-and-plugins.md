# Settings & Plugins

## Settings

Open Settings from the gear icon in the header. It's a tabbed dialog: a
**General** tab (your workspace's display title, and a place to manage
secrets), plus one tab for each feature that has its own configuration
(Gist sync, server sync, and so on). Changes save immediately as you type —
there's no separate Save button.

![Settings](./screenshots/settings.png)

See [Settings](settings.md) for the full guide: field types, workspace vs.
device scope, and how secrets work.

## Plugins

Almost everything in easyDBAccess — CSV import, sync buttons, cell
renderers — is a **plugin**: a small, sandboxed piece of code that adds one
feature. This means the app is easy to extend, and easy to trim down if you
don't need a feature.

Open the **Plugin Manager** (the small icon next to Settings) to:

- **Enable or disable** any built-in feature you don't want.
- **Add a plugin by URL** — paste a link to a plugin's `.js` file and it's
  fetched, cached for offline use, and loaded on next startup.
- **Filter** the list by type (importer, exporter, cell renderer, sync,
  etc.) or by installed/enabled state.

![Plugin Manager](./screenshots/plugin-manager.png)

Plugin URLs travel with your workspace, so a plugin you add shows up on
your other synced devices too.

### Being told about a new one

An app update can bring new plugins with it, and the only way to notice used to be
opening the Plugin Manager and looking. So the app now says so on startup: **"2
plugins you have never installed are available"**, naming them, with one button
that opens the manager.

It asks **once for each plugin**, whether you say yes or no. A plugin you install
and later remove is never offered again either — you have already decided about
that one. To look on purpose, run **Show available plugins** from the command
palette (Ctrl+K), which lists everything in your catalogs that is not installed
here, whether or not you were asked about it before.

Writing your own plugin is a single JavaScript file:

```js
export const meta = { name: 'my-plugin', version: '0.0.1' };

export function load(api) {
  api.ui.registerHeaderButton({
    id: 'my-plugin:hello',
    label: 'Hello',
    onClick: () => api.ui.dialogs.alert('hi from a plugin'),
  });
}
```

See the [developer plugin docs](../tech/PLUGINS.md) for the full API.
