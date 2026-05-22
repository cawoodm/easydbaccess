import type { HostApi, PluginModule } from '@easydb/shared';

export const meta: NonNullable<PluginModule['meta']> = {
  name: 'plugin-manager-button',
  version: '0.1.0',
  description: 'Registers a footer button that opens the Plugin Manager dialog.',
  author: 'easyDBAccess built-ins',
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
