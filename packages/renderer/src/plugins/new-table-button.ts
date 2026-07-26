import type { HostApi, PluginModule } from '@easydb/shared';

export const meta: NonNullable<PluginModule['meta']> = {
  id: 'new-table',
  name: 'New Table',
  version: '0.1.0',
  description: 'Registers the "+ New Table" header button.',
  author: 'easyDBAccess built-ins',
  icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>',
  repo: 'https://github.com/cawoodm/easydbaccess/blob/main/packages/renderer/src/plugins/new-table-button.ts',
};

/**
 * The "+ New Table" entry point lives as a plugin so the shell knows nothing
 * about table creation — it just renders registered header buttons. This is
 * the dogfooding pattern the architecture promises: anything that could be a
 * plugin IS a plugin, even when shipped by default.
 */
export function init(api: HostApi): void {
  api.ui.registerHeaderButton({
    id: 'new-table:open',
    label: 'New Table',
    icon: 'add',
    variant: 'primary',
    tooltip: 'Create a new table',
    onClick: () => api.ui.openNewTableDialog(),
  });
}
