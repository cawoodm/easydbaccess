import type { HostApi, PluginModule } from '@easydb/shared';

export const meta: NonNullable<PluginModule['meta']> = {
  id: 'plugin-manager-button',
  name: 'Plugin Manager',
  type: 'ui',
  version: '0.1.0',
  description: 'Registers a footer button that opens the Plugin Manager dialog.',
  author: 'easyDBAccess built-ins',
  icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg>',
  repo: 'https://github.com/cawoodm/easydbaccess/blob/main/packages/renderer/src/plugins/plugin-manager-button.ts',
  fixed: true,
};

export function init(api: HostApi): void {
  api.ui.registerFooterButton({
    id: 'plugin-manager:open',
    label: 'Plugins',
    icon: 'extension',
    tooltip: 'Add, disable, or remove plugins',
    onClick: () => api.ui.openPluginManager(),
  });
}
