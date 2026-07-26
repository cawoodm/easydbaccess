import type { HostApi, PluginModule } from '@easydb/shared';
import { parseSecrets, readSecretsText, writeSecretsText } from '../db/user-settings.js';

export const meta: NonNullable<PluginModule['meta']> = {
  name: 'settings',
  version: '0.1.0',
  description: 'Header gear button that opens the tabbed Settings dialog; imports dropped secrets.txt.',
  author: 'easyDBAccess built-ins',
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
