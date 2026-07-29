// Builds a GitHub-Wiki-ready copy of docs/help/ into .wiki-build/.
//
// GitHub wikis are a flat namespace (no subfolders in page URLs), so this
// rewrites the doc set's internal links to match, and copies screenshots
// verbatim (wiki repos support non-page asset subfolders fine).
//
// Pure build step — never touches git. `.github/workflows/wiki-sync.yml`
// runs this, then clones/updates the `<repo>.wiki.git` repo with the
// result. Runnable standalone: `node scripts/sync-wiki.mjs`.

import { readFileSync, writeFileSync, mkdirSync, readdirSync, copyFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, basename } from 'node:path';

const REPO_URL = 'https://github.com/cawoodm/easydbaccess';
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const HELP_DIR = resolve(REPO_ROOT, 'docs/help');
const OUT_DIR = resolve(REPO_ROOT, '.wiki-build');

function toWikiName(mdFilename) {
  const base = mdFilename.replace(/\.md$/, '');
  if (base.toUpperCase() === 'INDEX') return 'Home';
  return base
    .split('-')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join('-');
}

function toDisplayName(wikiName) {
  return wikiName.replace(/-/g, ' ');
}

function main() {
  rmSync(OUT_DIR, { recursive: true, force: true });
  mkdirSync(OUT_DIR, { recursive: true });

  const mdFiles = readdirSync(HELP_DIR).filter((f) => f.endsWith('.md'));
  const wikiNames = new Map(mdFiles.map((f) => [f, toWikiName(f)]));

  for (const file of mdFiles) {
    let content = readFileSync(resolve(HELP_DIR, file), 'utf8');

    // Local links to another docs/help page -> bare wiki page name.
    for (const [srcFile, wikiName] of wikiNames) {
      content = content.replaceAll(`](${srcFile})`, `](${wikiName})`);
    }

    // Cross-references into docs/tech/ (out of scope for the wiki) -> GitHub source URL.
    content = content.replace(
      /\]\(\.\.\/tech\/([^)]+\.md)\)/g,
      (_match, techFile) => `](${REPO_URL}/blob/main/docs/tech/${techFile})`,
    );

    writeFileSync(resolve(OUT_DIR, `${wikiNames.get(file)}.md`), content);
  }

  // Screenshots are referenced by relative path (./screenshots/x.png) and left
  // untouched above, so the folder just needs to exist alongside the pages.
  const screenshotsDir = resolve(HELP_DIR, 'screenshots');
  const outScreenshotsDir = resolve(OUT_DIR, 'screenshots');
  mkdirSync(outScreenshotsDir, { recursive: true });
  for (const f of readdirSync(screenshotsDir)) {
    copyFileSync(resolve(screenshotsDir, f), resolve(outScreenshotsDir, f));
  }

  // _Sidebar.md gives every page the same nav, since a flat wiki has no
  // folder structure to browse. Home first, then the rest alphabetically.
  const sidebarLines = ['**[Home](Home)**', ''];
  const rest = [...wikiNames.values()].filter((n) => n !== 'Home').sort();
  for (const name of rest) sidebarLines.push(`- [${toDisplayName(name)}](${name})`);
  writeFileSync(resolve(OUT_DIR, '_Sidebar.md'), sidebarLines.join('\n') + '\n');

  console.log(`Built ${mdFiles.length} wiki pages + _Sidebar.md into ${basename(OUT_DIR)}/`);
}

main();
