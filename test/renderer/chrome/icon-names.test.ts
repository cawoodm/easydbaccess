import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Every Material Icons name the app asks for must exist in the font.
 *
 * A name the font does not know is not a blank space — the ligature never fires
 * and the browser draws the WORD. `edb-file` shipped `icon: 'database'`, which
 * put the literal text "database" in the footer beside its label. The font has
 * `storage`, not `database`.
 *
 * This reads the icon inventory the `material-icons` package ships, so it stays
 * true when the package is updated.
 */

const require = createRequire(import.meta.url);
const KNOWN = new Set(Object.keys(require('material-icons/_data/versions.json') as Record<string, unknown>));

const PLUGINS = new URL('../../../packages/renderer/src/plugins/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const CHROME = new URL('../../../packages/renderer/src/chrome/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

/** `icon: 'name'` in a registration or a menu item. Single-quoted literals only. */
const ICON_LITERAL = /\bicon:\s*'([^']*)'/g;

interface Used {
  file: string;
  name: string;
}

function iconNamesIn(dir: string): Used[] {
  const out: Used[] = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.ts'))) {
    const source = readFileSync(join(dir, file), 'utf8');
    for (const match of source.matchAll(ICON_LITERAL)) {
      const name = match[1] ?? '';
      // `meta.icon` takes markup, not a ligature — the plugin manager draws it
      // with `unsafeHTML`. Those are a different thing and not checked here.
      if (name.trimStart().startsWith('<')) continue;
      // A name built at runtime is not a literal this check can judge.
      if (name.length === 0) continue;
      out.push({ file, name });
    }
  }
  return out;
}

describe('Material Icons names', () => {
  const used = [...iconNamesIn(PLUGINS), ...iconNamesIn(CHROME)];

  it('finds icon names to check, so a broken regex cannot pass silently', () => {
    expect(used.length).toBeGreaterThan(20);
    expect(used.map((u) => u.name)).toContain('storage');
  });

  it('every name exists in the font', () => {
    const missing = used.filter((u) => !KNOWN.has(u.name)).map((u) => `${u.file}: ${u.name}`);
    expect(missing).toEqual([]);
  });
});
