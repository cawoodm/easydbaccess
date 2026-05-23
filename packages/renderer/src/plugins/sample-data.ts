import type { HostApi, PluginModule } from '@easydb/shared';
import { importJsonText } from './json-import.js';

const DEFAULT_URL =
  'https://raw.githubusercontent.com/cawoodm/easydbaccess/main/data/northwind.db.json';

export const meta: NonNullable<PluginModule['meta']> = {
  name: 'sample-data',
  version: '0.1.0',
  description: 'Header button that loads a sample database from a URL (defaults to Northwind).',
  author: 'easyDBAccess built-ins',
  optional: true,
};

export function init(api: HostApi): void {
  api.ui.registerHeaderButton({
    id: 'sample-data:load',
    label: 'Sample data',
    icon: 'database',
    tooltip: 'Fetch a JSON dump from a URL and import it',
    onClick: () => loadSample(api),
  });
}

async function loadSample(api: HostApi): Promise<void> {
  const url = await api.ui.dialogs.prompt(
    'URL of a JSON dump to import. The default is the Northwind sample from this repo.',
    DEFAULT_URL,
    'Load sample data',
  );
  if (!url) return;

  try {
    const res = await api.backend.fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    const text = await res.text();
    const filename = filenameFromUrl(url);
    await importJsonText(api, text, filename);
  } catch (err) {
    api.ui.dialogs.toast(
      `Could not load ${url}: ${(err as Error).message}`,
      { kind: 'error', title: 'Sample data' },
    );
  }
}

function filenameFromUrl(url: string): string {
  try {
    const path = new URL(url).pathname;
    const last = path.split('/').filter(Boolean).pop();
    return last && last.length > 0 ? last : 'sample.db.json';
  } catch {
    return 'sample.db.json';
  }
}
