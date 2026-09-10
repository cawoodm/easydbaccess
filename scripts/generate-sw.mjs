// Generate `dist/sw.js` — the service worker that makes the hosted browser
// build load with no internet.
//
// The worker's SOURCE is `scripts/sw-template.js`; this file only decides WHAT
// to precache and stamps the cache name. Wired into
// `packages/renderer/vite.config.ts` as the `gen-service-worker` plugin, which
// runs it in `closeBundle` — the first hook that runs AFTER Vite has copied
// `public/` into `dist/`, so `plugins/*.js`, `manifest.webmanifest` and
// `favicon.svg` are on disk to be listed.
//
// Also runnable by hand once a build exists:
//   node scripts/generate-sw.mjs packages/renderer/dist /easydbaccess/
//
// Why a hand-rolled worker instead of `vite-plugin-pwa`: every asset this app
// ships is already content-hashed by Vite, and the handful that are not
// (`index.html`, the manifest, the favicon, `plugins/*`) are rewritten on every
// deploy. A per-deploy cache name is therefore a complete revisioning scheme,
// which is the one hard thing Workbox exists to do. See docs/tech/OFFLINE.md.

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, posix, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const templatePath = resolve(here, 'sw-template.js');

/**
 * Files that are NOT worth a place in the precache.
 *
 * `.map` is devtools-only and is by far the biggest thing in `dist/` (roughly
 * two thirds of it). `.woff` is dead weight: every `@font-face` in
 * `material-icons.css` lists `woff2` first and every browser this app targets
 * takes it, so the `.woff` copies are never requested. `sw.js` must not cache
 * itself, and a `.DS_Store`-style stray should never make `addAll` fail — one
 * missing entry rejects the whole install and leaves the user with no worker.
 */
function isExcluded(relPath) {
  if (relPath === 'sw.js') return true;
  if (relPath.endsWith('.map')) return true;
  if (relPath.endsWith('.woff')) return true;
  if (relPath.startsWith('.') || relPath.includes('/.')) return true;
  return false;
}

/**
 * The precache list for a set of build-relative file paths.
 *
 * Pure and sorted, so the same `dist/` always produces the same list — which is
 * what lets the cache name double as a content check (see `cacheName`).
 */
export function precacheList(files, base = '/') {
  const prefix = base.endsWith('/') ? base : `${base}/`;
  return files
    .filter((f) => !isExcluded(f))
    .map((f) => posix.join(prefix, f))
    .sort();
}

/** Short, stable content id for a precache list. */
function listHash(entries) {
  return createHash('sha256').update(entries.join('\n')).digest('hex').slice(0, 8);
}

/**
 * The cache name.
 *
 * The version alone would do — `.githooks/pre-commit` bumps it on every commit —
 * but a branch preview can be rebuilt and redeployed without a commit, and the
 * list hash is what makes that deploy get a fresh cache instead of serving the
 * previous build's assets forever.
 */
export function cacheName(version, entries) {
  return `easydb-precache-v${version}-${listHash(entries)}`;
}

/**
 * The finished worker source. Pure — takes the template text, returns JS.
 *
 * Anchored to the two declaration lines rather than substituting the bare
 * placeholder names: those names are also spelled out in the template's own
 * header comment, and a plain `replace` rewrote the COMMENT and left the real
 * declaration untouched.
 */
export function buildServiceWorker({ template, files, version, base }) {
  const entries = precacheList(files, base);
  let out = template;
  for (const [decl, value] of [
    ['const CACHE = __CACHE_NAME__;', `const CACHE = ${JSON.stringify(cacheName(version, entries))};`],
    ['const PRECACHE = __PRECACHE__;', `const PRECACHE = ${JSON.stringify(entries, null, 2)};`],
  ]) {
    if (!out.includes(decl)) throw new Error(`service worker template is missing its "${decl}" line`);
    out = out.replace(decl, value);
  }
  return out;
}

/** Every file under `dir`, as `/`-joined paths relative to it. */
function walk(dir, prefix = '') {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...walk(resolve(dir, entry.name), rel));
    else out.push(rel);
  }
  return out;
}

/** Walk a finished `dist/`, write `sw.js` into it, and report what it covers. */
export function generateServiceWorker({ outDir, version, base }) {
  const template = readFileSync(templatePath, 'utf8');
  const files = walk(outDir);
  const source = buildServiceWorker({ template, files, version, base });
  writeFileSync(resolve(outDir, 'sw.js'), source);
  const count = precacheList(files, base).length;
  console.log(`service worker: ${count} precached files, scope ${base}`);
  return count;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const outDir = resolve(process.argv[2] ?? 'packages/renderer/dist');
  const base = process.argv[3] ?? '/';
  const pkg = JSON.parse(readFileSync(resolve(here, '..', 'package.json'), 'utf8'));
  generateServiceWorker({ outDir, version: pkg.version, base });
}
