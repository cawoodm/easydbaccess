import type { HostApi, PluginModule } from '@easydb/shared';
import { parseSecrets, readSecretsText, writeSecretsText } from '../db/user-settings.js';

export const meta: NonNullable<PluginModule['meta']> = {
  id: 'settings',
  name: 'Settings',
  version: '0.1.0',
  description: 'Header gear button that opens the tabbed Settings dialog; imports dropped secrets.txt.',
  author: 'easyDBAccess built-ins',
  icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>',
  repo: 'https://github.com/cawoodm/easydbaccess/blob/main/packages/renderer/src/plugins/settings.ts',
};

export function init(api: HostApi): void {
  api.ui.registerHeaderButton({
    id: 'settings:open',
    label: 'Settings',
    icon: 'settings',
    tooltip: 'Workspace and plugin settings',
    variant: 'secondary',
    onClick: () => api.ui.openSettings(),
  });

  // Drag-and-drop a `secrets.txt` to load the device-local secrets store.
  // Registered first among built-ins so it claims the drop before the CSV/JSON
  // importers; it only handles a file literally named `secrets.txt` and returns
  // false for anything else, so normal data imports are unaffected.
  api.ui.registerDropHandler(async (event, api) => {
    const files = Array.from(event.dataTransfer?.files ?? []);
    const file = files.find((f) => f.name.toLowerCase() === 'secrets.txt');
    if (!file) return false;

    const text = await file.text();
    const count = Object.keys(parseSecrets(text)).length;

    if (readSecretsText().trim().length > 0) {
      const ok = await api.ui.dialogs.confirm(
        `Replace your current secrets with ${count} secret${count === 1 ? '' : 's'} from "${file.name}"?`,
        'Import secrets',
      );
      if (!ok) return true; // drop consumed, but the user declined
    }

    writeSecretsText(text);
    api.ui.dialogs.toast(`Imported ${count} secret${count === 1 ? '' : 's'}.`, {
      kind: 'success',
      title: 'Secrets',
    });
    return true;
  });
}
