import type { HostApi, PluginModule } from '@easydb/shared';

export const meta: NonNullable<PluginModule['meta']> = {
  name: 'header-clock',
  version: '0.1.0',
  description: 'Tiny demo plugin — a header button that toasts the current time.',
  author: 'easyDBAccess built-ins',
};

/**
 * The smallest possible dogfood of registerHeaderButton: one ~10-line
 * function that adds a "Now" button to the header. Click → toast with
 * the current local time. Useful as a reference for plugin authors
 * starting from zero.
 */
export function init(api: HostApi): void {
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
