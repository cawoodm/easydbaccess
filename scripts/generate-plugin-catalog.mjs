// Regenerate packages/renderer/public/plugins/catalog.json from the meta
// exported by each plugin .js file in that directory.
//
// Each plugin exports `export const meta = { id, name, version, description,
// author, icon, repo }` at its top level. Importing the module in Node only runs that
// top-level code (defines meta + a function) — it never touches browser
// APIs — so a plain dynamic import is safe here. If import fails for any
// reason, we fall back to regex-extracting the meta object literal from the
// file text.
//
// Wired into packages/renderer/vite.config.ts's buildStart so the catalog
// stays in sync with the plugin files without a manual step; also runnable
// directly: `node scripts/generate-plugin-catalog.mjs`.

import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve, basename } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pluginsDir = resolve(root, 'packages/renderer/public/plugins');
const catalogPath = resolve(pluginsDir, 'catalog.json');

function titleCase(s) {
  return s
    .split(/[-_]/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

async function readMeta(file) {
  try {
    const mod = await import(/* @vite-ignore */ pathToFileURL(file).href);
    if (mod.meta) return mod.meta;
  } catch {
    // Fall through to the regex fallback below.
  }

  const src = readFileSync(file, 'utf8');
  const match = src.match(/export const meta\s*=\s*(\{[\s\S]*?\n\});/);
  if (!match) return null;
  try {
    return new Function(`return (${match[1]})`)();
  } catch {
    return null;
  }
}

export async function generatePluginCatalog() {
  const files = readdirSync(pluginsDir).filter((f) => f.endsWith('.js'));

  const entries = [];
  for (const file of files) {
    const fullPath = resolve(pluginsDir, file);
    const meta = await readMeta(fullPath);
    if (!meta) {
      console.warn(`plugin catalog: skipping ${file} — could not resolve meta`);
      continue;
    }

    const base = basename(file, '.js');
    const id = meta.id ?? meta.name ?? base;
    const entry = { id, name: meta.name ?? titleCase(id) };
    if (meta.description !== undefined) entry.description = meta.description;
    if (meta.author !== undefined) entry.author = meta.author;
    if (meta.version !== undefined) entry.version = meta.version;
    if (meta.icon !== undefined) entry.icon = meta.icon;
    if (meta.repo !== undefined) entry.repo = meta.repo;
    entry.url = `./${file}`;
    entries.push(entry);
  }

  entries.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const catalog = { $schema: 'easydb-plugin-catalog-v1', plugins: entries };
  const next = `${JSON.stringify(catalog, null, 2)}\n`;

  let current = null;
  try {
    current = readFileSync(catalogPath, 'utf8');
  } catch {
    // No existing file — treat as changed.
  }

  const changed = current !== next;
  if (changed) writeFileSync(catalogPath, next);

  console.log(`plugin catalog: ${entries.length} entries (${changed ? 'written' : 'unchanged'})`);
  return changed;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  generatePluginCatalog();
}
