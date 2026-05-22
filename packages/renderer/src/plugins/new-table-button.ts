import type { HostApi, PluginModule } from '@easydb/shared';

export const meta: NonNullable<PluginModule['meta']> = {
  name: 'new-table',
  version: '0.1.0',
  description: 'Registers the "+ New Table" header button.',
  author: 'easyDBAccess built-ins',
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
    label: '+ New Table',
    variant: 'primary',
    tooltip: 'Create a new table',
    onClick: () => api.ui.openNewTableDialog(),
  });
}
