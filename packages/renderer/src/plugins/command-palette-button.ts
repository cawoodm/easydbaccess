import type { HostApi, PluginModule } from '@easydb/shared';

export const meta: NonNullable<PluginModule['meta']> = {
  id: 'command-palette-button',
  name: 'Command Palette Button',
  type: 'ui',
  version: '0.1.0',
  description: 'Header “>” button that opens the command palette (also Ctrl/⌘K).',
  author: 'Marc Cawood',
  icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 6 15 12 9 18"/></svg>',
  repo: 'https://github.com/cawoodm/easydbaccess/blob/main/packages/renderer/src/plugins/command-palette-button.ts',
};

/**
 * A header launcher for the command palette. The palette is core (bound to
 * Ctrl/⌘K and opened via `ui.openCommandPalette()`); this plugin just adds the
 * discoverable “>” button so it isn't keyboard-only.
 */
export function init(api: HostApi): void {
  api.ui.registerHeaderButton({
    id: 'command-palette:open',
    label: 'Commands',
    icon: 'chevron_right',
    tooltip: 'Open the command palette (Ctrl/⌘K)',
    // A utility action, not one of the header's main calls to action: it belongs
    // with search / plugins / help / settings on the far right, as an icon.
    variant: 'secondary',
    onClick: () => api.ui.openCommandPalette(),
  });
}
