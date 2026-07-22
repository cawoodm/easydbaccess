#!/usr/bin/env node
// Bump the build version and keep the renderer's <title> in sync.
//
// Default: increment the patch version in package.json AND rewrite every place
// the version is shown to match, then stage the files. Displayed spots:
//   - packages/renderer/index.html   <title>easyDBAccess vX.Y.Z</title>
//   - packages/renderer/src/chrome/app-shell.ts   header <span class="version">
// With --sync-only: don't bump; just make the displayed versions match
// package.json's current version (useful for repairing drift).
//
// Wired to run on every commit via .githooks/pre-commit. package.json stays the
// single source of truth for the version; the publish scripts read it from there.

import { readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkgPath = resolve(root, 'package.json');
const indexPath = resolve(root, 'packages/renderer/index.html');
const shellPath = resolve(root, 'packages/renderer/src/chrome/app-shell.ts');
const syncOnly = process.argv.includes('--sync-only');

const pkgRaw = readFileSync(pkgPath, 'utf8');
const current = JSON.parse(pkgRaw).version;
let version = current;

if (!syncOnly) {
  const [maj = '0', min = '0', patch = '0'] = String(current).split('.');
  version = `${maj}.${min}.${Number.parseInt(patch, 10) + 1}`;
  // Replace only the first "version": "…" (the top-level one, before deps).
  writeFileSync(pkgPath, pkgRaw.replace(/("version"\s*:\s*")[^"]+(")/, `$1${version}$2`));
}

// Replace the version string in each displayed spot without touching anything else.
const edits = [
  [indexPath, /(<title>easyDBAccess v)\d+\.\d+\.\d+(<\/title>)/],
  [shellPath, /(<span class="version">v)\d+\.\d+\.\d+(<\/span>)/],
];
const changed = [pkgPath];
for (const [path, re] of edits) {
  const src = readFileSync(path, 'utf8');
  const next = src.replace(re, `$1${version}$2`);
  if (next !== src) writeFileSync(path, next);
  changed.push(path);
}

try {
  execSync(`git add ${changed.map((p) => `"${p}"`).join(' ')}`, { stdio: 'ignore' });
} catch {
  // Not fatal outside a git context.
}

console.log(`version ${syncOnly ? 'synced to' : 'bumped to'} ${version}`);
