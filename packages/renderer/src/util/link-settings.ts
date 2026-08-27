// packages/renderer/src/util/link-settings.ts
//
// The `links:protocols` setting, and the one place that pushes it into the pure
// rule in `util/url-schemes.ts`.
//
// It sits in its own module for the same reason `table/grid-settings.ts` does:
// the `settings` plugin REGISTERS the field because it owns the Settings tab, and
// the sanitizer and the Link renderer READ it while painting. Neither may import
// the other — a util importing a plugin would invert the plugin model.
//
// The read is async and every reader is sync, so the value is resolved ONCE at
// boot into module state and re-resolved when the dialog reports a change. A
// per-use read is not open to us: `safeUrl` runs inside a string replace and
// `detectLink` inside a cell paint.

import { SETTINGS_CHANGED_EVENT, type SettingsChangedDetail } from '../db/settings-events.js';
import { DEFAULT_PROTOCOLS, parseProtocolPolicy, setProtocolPolicy } from './url-schemes.js';

export const LINK_SETTINGS_ID = 'links';
export const LINK_PROTOCOLS_KEY = 'protocols';

/** Just enough of `SettingsApi` to read one value — so a test can pass a fake. */
export interface SettingsReader {
  get<T>(pluginId: string, key: string): Promise<T | undefined>;
}

/** The setting's text, as the user wrote it. Empty ⇒ the shipped default. */
export async function readLinkProtocols(settings: SettingsReader): Promise<string> {
  const raw: unknown = await settings.get<string>(LINK_SETTINGS_ID, LINK_PROTOCOLS_KEY);
  return typeof raw === 'string' && raw.trim() !== '' ? raw : DEFAULT_PROTOCOLS;
}

/** Resolve the setting into the live policy. */
export async function applyLinkPolicy(settings: SettingsReader): Promise<void> {
  setProtocolPolicy(parseProtocolPolicy(await readLinkProtocols(settings)));
}

/**
 * Resolve it now and keep it resolved. Returns an unsubscribe, though nothing
 * calls it: the policy is app-wide and lives as long as the page.
 *
 * A link the user has just allowed appears without a reload, because every
 * renderer asks the rule at paint time — but only after something repaints, so
 * the change lands on the next render of a cell, not on the open one.
 */
export function startLinkPolicy(settings: SettingsReader): () => void {
  void applyLinkPolicy(settings);
  if (typeof document === 'undefined') return () => {};
  const onChange = (e: Event) => {
    const detail = (e as CustomEvent<SettingsChangedDetail>).detail;
    if (detail?.pluginId !== LINK_SETTINGS_ID) return;
    void applyLinkPolicy(settings);
  };
  document.addEventListener(SETTINGS_CHANGED_EVENT, onChange);
  return () => document.removeEventListener(SETTINGS_CHANGED_EVENT, onChange);
}
