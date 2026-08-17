/**
 * Device-local settings layer + secrets store.
 *
 * The workspace layer lives in the synced `settings` collection. This module
 * is the *user* layer: a single JSON blob in localStorage that never syncs, so
 * it holds device-local overrides (tokens, poll intervals, machine URLs). It
 * shadows the workspace layer at read time — see `SettingsApi` in api-factory.
 *
 * Secrets are a separate cross-workspace store, a `key: value` text file the
 * user edits in the Settings dialog. String setting values may embed
 * `${secret:name}` references, resolved by `interpolateSecrets`.
 *
 * All functions take an optional `Storage` shim so they're unit-testable
 * without a DOM (pass a Map-backed fake); they default to `localStorage`.
 */

export const USER_SETTINGS_KEY = '/easydbaccess/settings.json';
export const SECRETS_KEY = '/easydbaccess/secrets.txt';

/** Minimal subset of the Web Storage API we actually use. */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function store(shim?: StorageLike): StorageLike | null {
  if (shim) return shim;
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null; // private mode / disabled
  }
}

// -- User settings blob -----------------------------------------------------

export function readUserSettings(shim?: StorageLike): Record<string, unknown> {
  const s = store(shim);
  if (!s) return {};
  const raw = s.getItem(USER_SETTINGS_KEY);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function readUserSetting(key: string, shim?: StorageLike): unknown {
  return readUserSettings(shim)[key];
}

export function writeUserSetting(key: string, value: unknown, shim?: StorageLike): void {
  const s = store(shim);
  if (!s) return;
  const all = readUserSettings(shim);
  all[key] = value;
  s.setItem(USER_SETTINGS_KEY, JSON.stringify(all));
}

export function removeUserSetting(key: string, shim?: StorageLike): void {
  const s = store(shim);
  if (!s) return;
  const all = readUserSettings(shim);
  if (!(key in all)) return;
  delete all[key];
  s.setItem(USER_SETTINGS_KEY, JSON.stringify(all));
}

export function hasUserSetting(key: string, shim?: StorageLike): boolean {
  return key in readUserSettings(shim);
}

export function exportUserSettingsBlob(shim?: StorageLike): string {
  return JSON.stringify(readUserSettings(shim), null, 2);
}

export function importUserSettingsBlob(json: string, shim?: StorageLike): void {
  const s = store(shim);
  if (!s) return;
  const parsed = JSON.parse(json) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Expected a JSON object');
  }
  s.setItem(USER_SETTINGS_KEY, JSON.stringify(parsed));
}

// -- Secrets ----------------------------------------------------------------

export function readSecretsText(shim?: StorageLike): string {
  const s = store(shim);
  return s?.getItem(SECRETS_KEY) ?? '';
}

export function writeSecretsText(text: string, shim?: StorageLike): void {
  store(shim)?.setItem(SECRETS_KEY, text);
}

/** Parses the `key: value` secrets file. Blank lines and `#` comments ignored. */
export function parseSecrets(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf(':');
    if (idx < 0) continue;
    const name = trimmed.slice(0, idx).trim();
    const value = trimmed.slice(idx + 1).trim();
    if (name) out[name] = value;
  }
  return out;
}

/**
 * Replaces `${secret:name}` tokens in a string with the matching secret.
 * Unknown names are left as-is so a missing secret is visible rather than
 * silently becoming an empty string.
 */
export function interpolateSecrets(value: string, secrets: Record<string, string>): string {
  return value.replace(/\$\{secret:([^}]+)\}/g, (m, name: string) => {
    const hit = secrets[name.trim()];
    return hit === undefined ? m : hit;
  });
}
