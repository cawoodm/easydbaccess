import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
// @ts-expect-error — a plain .mjs build script, deliberately untyped like its
// siblings (`generate-plugin-catalog.mjs`, `generate-tips.mjs`).
import { buildServiceWorker, cacheName, precacheList } from '../../../scripts/generate-sw.mjs';

/**
 * What the service worker precaches, and how its cache is named.
 *
 * Both are pure functions on a file list, so the rules can be pinned down here
 * without running a build. The two that matter:
 *
 *  - The list decides whether the app loads offline at all. A missing `.wasm`
 *    or a missing font is a broken app, not a degraded one.
 *  - The cache name decides whether a deploy is ever seen. Two different builds
 *    sharing a name would serve the older one forever.
 */

const template = readFileSync(fileURLToPath(new URL('../../../scripts/sw-template.js', import.meta.url)), 'utf8');

const FILES = [
  'index.html',
  'favicon.svg',
  'manifest.webmanifest',
  'assets/index-CtG5HmKv.js',
  'assets/index-CtG5HmKv.js.map',
  'assets/index-abc123.css',
  'assets/sqlite3-BVKGSWc-.wasm',
  'assets/material-icons-1a2b3c.woff2',
  'assets/material-icons-1a2b3c.woff',
  'plugins/catalog.json',
  'plugins/header-clock.js',
  'sw.js',
];

describe('precacheList', () => {
  it('keeps everything the app needs to boot with no network', () => {
    const list = precacheList(FILES, '/easydbaccess/');
    expect(list).toContain('/easydbaccess/index.html');
    expect(list).toContain('/easydbaccess/assets/index-CtG5HmKv.js');
    expect(list).toContain('/easydbaccess/assets/index-abc123.css');
    // The SQLite build IS the data layer — without it there is no app offline.
    expect(list).toContain('/easydbaccess/assets/sqlite3-BVKGSWc-.wasm');
    expect(list).toContain('/easydbaccess/assets/material-icons-1a2b3c.woff2');
    // Catalog plugins are same-origin and are re-fetched on every boot.
    expect(list).toContain('/easydbaccess/plugins/header-clock.js');
    expect(list).toContain('/easydbaccess/manifest.webmanifest');
  });

  it('drops the weight nothing asks for', () => {
    const list = precacheList(FILES, '/easydbaccess/');
    // Sourcemaps are devtools-only and are the bulk of dist/.
    expect(list.some((e: string) => e.endsWith('.map'))).toBe(false);
    // Every @font-face lists woff2 first, so the .woff copies are dead weight.
    expect(list.some((e: string) => e.endsWith('.woff'))).toBe(false);
    // The worker must never cache itself.
    expect(list).not.toContain('/easydbaccess/sw.js');
  });

  it('works at the root base as well as under a deploy subpath', () => {
    expect(precacheList(['index.html'], '/')).toEqual(['/index.html']);
    expect(precacheList(['index.html'], '/easydbaccess3/')).toEqual(['/easydbaccess3/index.html']);
  });

  it('is order-independent, so a directory walk cannot change the result', () => {
    const a = precacheList(FILES, '/x/');
    const b = precacheList([...FILES].reverse(), '/x/');
    expect(a).toEqual(b);
  });
});

describe('cacheName', () => {
  it('is stable for the same build', () => {
    const list = precacheList(FILES, '/x/');
    expect(cacheName('0.0.461', list)).toBe(cacheName('0.0.461', list));
  });

  it('changes when the version changes', () => {
    const list = precacheList(FILES, '/x/');
    expect(cacheName('0.0.461', list)).not.toBe(cacheName('0.0.462', list));
  });

  it('changes when the assets change without a version bump — a branch preview', () => {
    const before = precacheList(FILES, '/x/');
    const after = precacheList([...FILES.filter((f) => f !== 'assets/index-CtG5HmKv.js'), 'assets/index-ZZZZ.js'], '/x/');
    expect(cacheName('0.0.461', before)).not.toBe(cacheName('0.0.461', after));
  });
});

/** The worker with its comments removed, so a rule is checked against code. */
function codeOf(sw: string): string {
  return sw
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\/\*|\*)/.test(line))
    .join('\n');
}

describe('buildServiceWorker', () => {
  it('substitutes the real declarations, not the header comment', () => {
    const sw = buildServiceWorker({ template, files: FILES, version: '0.0.461', base: '/easydbaccess/' });
    const code = codeOf(sw);
    expect(code).not.toContain('__CACHE_NAME__');
    expect(code).not.toContain('__PRECACHE__');
    expect(code).toContain('"/easydbaccess/assets/sqlite3-BVKGSWc-.wasm"');
    expect(code).toMatch(/const CACHE = "easydb-precache-v0\.0\.461-[0-9a-f]{8}";/);
  });

  it('fails loudly if the template loses a declaration', () => {
    expect(() => buildServiceWorker({ template: '// nothing here', files: FILES, version: '1', base: '/' })).toThrow(/missing/);
  });

  it('never takes over a running page on its own', () => {
    const code = codeOf(buildServiceWorker({ template, files: FILES, version: '0.0.461', base: '/' }));
    // `skipWaiting` may appear ONLY in the message handler the page calls after
    // the user presses Reload — never in `install`, and `clients.claim()` not
    // at all. A silent takeover would hand a live page a cache without the
    // lazily-imported chunks it is about to ask for.
    expect(code).not.toContain('clients.claim');
    const install = code.slice(code.indexOf("addEventListener('install'"), code.indexOf("addEventListener('activate'"));
    expect(install).not.toContain('skipWaiting');
  });
});
