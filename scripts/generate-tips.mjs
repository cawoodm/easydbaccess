// Compile docs/help/tips.md into packages/renderer/src/plugins/tips.json, the
// data the `tips` built-in plugin imports.
//
// The markdown file is the source the user edits; the JSON is generated, so it
// must not be hand-edited. Every top-level list item ("- …" or "* …") is one
// tip. Headings, prose and blank lines are ignored, so the same file stays
// readable as a help page.
//
// A tip's id is a slug of its own text. That is deliberate: editing a tip
// changes its id, so the edited tip counts as unseen and is shown again.
//
// Wired into packages/renderer/vite.config.ts's buildStart (like the plugin
// catalog) so the JSON follows the markdown on every dev start and build; also
// runnable directly: `node scripts/generate-tips.mjs`.

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourcePath = resolve(root, 'docs/help/tips.md');
const outputPath = resolve(root, 'packages/renderer/src/plugins/tips.json');

/** Slug used as the tip id. Truncated so a long tip doesn't make an unwieldy key. */
function slug(text) {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48)
      .replace(/-+$/, '') || 'tip'
  );
}

/** Parses the markdown into `{ id, text }` tips. Exported for reuse and tests. */
export function parseTips(markdown) {
  const tips = [];
  const used = new Set();
  for (const line of markdown.split(/\r?\n/)) {
    const match = /^\s*[-*]\s+(.*\S)\s*$/.exec(line);
    if (!match) continue;
    const text = match[1];
    let id = slug(text);
    // Two tips can slug to the same key (same first 48 characters). Suffix so
    // the seen-list can still tell them apart.
    if (used.has(id)) {
      let n = 2;
      while (used.has(`${id}-${n}`)) n += 1;
      id = `${id}-${n}`;
    }
    used.add(id);
    tips.push({ id, text });
  }
  return tips;
}

export function generateTips() {
  const tips = parseTips(readFileSync(sourcePath, 'utf8'));
  const next = `${JSON.stringify({ $schema: 'easydb-tips-v1', tips }, null, 2)}\n`;

  let current = null;
  try {
    current = readFileSync(outputPath, 'utf8');
  } catch {
    // No existing file — treat as changed.
  }

  const changed = current !== next;
  if (changed) writeFileSync(outputPath, next);

  console.log(`tips: ${tips.length} entries (${changed ? 'written' : 'unchanged'})`);
  return changed;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  generateTips();
}
