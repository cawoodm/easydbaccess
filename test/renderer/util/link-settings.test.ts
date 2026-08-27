import { afterEach, describe, expect, it } from 'vitest';
import { applyLinkPolicy, LINK_PROTOCOLS_KEY, LINK_SETTINGS_ID, readLinkProtocols, startLinkPolicy } from '../../../packages/renderer/src/util/link-settings.js';
import { DEFAULT_PROTOCOLS, protocolPolicy, setProtocolPolicy } from '../../../packages/renderer/src/util/url-schemes.js';
import { safeUrl } from '../../../packages/renderer/src/util/sanitize-html.js';

/**
 * The `links:protocols` setting is async and every reader of it is sync, so this
 * module is the bridge: resolve once at boot into module state, re-resolve on
 * change. See `util/link-settings.ts`.
 */

function fakeSettings(value?: unknown): { get<T>(pluginId: string, key: string): Promise<T | undefined>; reads: string[] } {
  const reads: string[] = [];
  return {
    reads,
    get<T>(pluginId: string, key: string): Promise<T | undefined> {
      reads.push(`${pluginId}:${key}`);
      return Promise.resolve(value as T | undefined);
    },
  };
}

afterEach(() => setProtocolPolicy(null));

describe('readLinkProtocols', () => {
  it('reads the one key the settings tab registers', async () => {
    const settings = fakeSettings('http,https');
    expect(await readLinkProtocols(settings)).toBe('http,https');
    expect(settings.reads).toEqual([`${LINK_SETTINGS_ID}:${LINK_PROTOCOLS_KEY}`]);
  });

  it('gives the shipped default for nothing stored, or a value that is not text', async () => {
    for (const stored of [undefined, null, '', '   ', 42]) {
      expect(await readLinkProtocols(fakeSettings(stored))).toBe(DEFAULT_PROTOCOLS);
    }
  });
});

describe('applyLinkPolicy', () => {
  it('puts the stored list in force', async () => {
    await applyLinkPolicy(fakeSettings('http,https'));
    expect(protocolPolicy().deny).toBe(false);
    expect(safeUrl('file:///C:/x.html')).toBeNull();
    expect(safeUrl('https://x.dev')).toBe('https://x.dev');
  });

  it('an unset setting leaves the default in force', async () => {
    await applyLinkPolicy(fakeSettings(undefined));
    expect(protocolPolicy().deny).toBe(true);
    expect(safeUrl('file:///C:/x.html')).toBe('file:///C:/x.html');
    expect(safeUrl('javascript:alert(1)')).toBeNull();
  });
});

describe('startLinkPolicy', () => {
  it('resolves the setting without waiting to be awaited, and survives having no document', async () => {
    // The unit suite runs in plain Node: no `document`, so the change listener is
    // skipped and the first read still has to happen.
    const stop = startLinkPolicy(fakeSettings('ftp'));
    await Promise.resolve();
    await Promise.resolve();
    expect(safeUrl('ftp://host/f')).toBe('ftp://host/f');
    expect(safeUrl('https://x.dev')).toBeNull();
    expect(() => stop()).not.toThrow();
  });
});
