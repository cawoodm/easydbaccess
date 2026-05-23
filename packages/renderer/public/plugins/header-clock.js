/**
 * header-clock — reference plugin loaded dynamically from the host.
 *
 * Served from /plugins/header-clock.js by Vite (or any other static host).
 * Listed in /plugins/catalog.json so the Plugin Manager dialog can offer it
 * for one-click install. Once installed, the absolute URL is stored on
 * Workspace.pluginUrls and re-loaded by url-loader.ts on every boot.
 *
 * Plain JS — no bare imports — because the host wraps the body in a Blob URL
 * and dynamic-imports it; bare specifiers wouldn't resolve in that context.
 */

export const meta = {
  name: 'header-clock',
  version: '0.1.0',
  description: 'Tiny demo plugin — a header button that toasts the current time.',
  author: 'easyDBAccess reference',
};

export function init(api) {
  api.ui.registerHeaderButton({
    id: 'header-clock:now',
    label: 'Now',
    icon: 'schedule',
    tooltip: 'Show the current time',
    onClick: () =>
      api.ui.dialogs.toast(new Date().toString(), {
        kind: 'info',
        title: 'Now',
        durationMs: 6000,
      }),
  });
}
