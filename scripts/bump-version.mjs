#!/usr/bin/env node
// Bump the build version and keep the renderer's <title> in sync.
//
// Default: increment the patch version in package.json AND rewrite the version
// shown in packages/renderer/index.html's <title> to match, then stage both.
// With --sync-only: don't bump; just make index.html match package.json's
// current version (useful for repairing drift).
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

const html = readFileSync(indexPath, 'utf8');
const nextHtml = html.replace(/<title>easyDBAccess[^<]*<\/title>/, `<title>easyDBAccess v${version}</title>`);
if (nextHtml !== html) writeFileSync(indexPath, nextHtml);

try {
  execSync(`git add "${pkgPath}" "${indexPath}"`, { stdio: 'ignore' });
} catch {
  // Not fatal outside a git context.
}

console.log(`version ${syncOnly ? 'synced to' : 'bumped to'} ${version}`);
