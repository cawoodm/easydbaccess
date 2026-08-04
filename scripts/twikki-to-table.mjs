#!/usr/bin/env node
// Convert a twikki dump into importable easyDBAccess `.table.json` files.
//
// twikki (C:\projects\Marc\twikki) is a TiddlyWiki-like app whose tiddlers are
// NOT tabular — they live in one localStorage key. This turns them into tables.
//
// Three input shapes are accepted, because all three are called "a twikki dump"
// in practice:
//   1. `<workspace>.workspace.json` — the $DumpWorkspacePlugin format
//      `{format:'twikki-workspace-v1', workspace, keys:{tiddlers:'<JSON>', …}}`,
//      where `keys.tiddlers` is the raw localStorage STRING, not an array.
//   2. A bare array of tiddlers — what the Backup plugin writes.
//   3. An easyDBAccess dump (`workspace-*.db.json`) or a single `.table.json`,
//      i.e. tiddlers that already went through an import once.
//
// Output is one file per twikki `package` (`tiddlers-bible.table.json`,
// `tiddlers-base.table.json`, …) so a 1400-tiddler dump doesn't land as one
// table mixing bible chapters with plugin source. `--single` combines them.
//
// Usage:
//   node scripts/twikki-to-table.mjs <dump.json> [options]
//     -o, --out <dir>      output directory (default: the input file's folder)
//     --single             one combined table instead of one per package
//     --package <name>     only this package
//     --name <base>        table base name (default: tiddlers)

import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { basename, dirname, resolve } from 'node:path';

/** Table name for tiddlers carrying no `package` (hand-written ones). */
const UNPACKAGED = '';

/**
 * The tiddler → column mapping, in display order. `text` gets the markdown
 * renderer and `tags` the `array`/tags pair, matching what the app itself
 * stores for a tiddler table — an imported table then reads like a native one.
 */
const COLUMNS = [
  { field: 'title', label: 'title', type: 'string', unique: true, notnull: true },
  { field: 'text', label: 'text', type: 'string', renderer: 'markdown' },
  { field: 'tags', label: 'tags', type: 'array', renderer: 'tags' },
  { field: 'type', label: 'type', type: 'string' },
  { field: 'created', label: 'created', type: 'datetime' },
  { field: 'updated', label: 'updated', type: 'datetime' },
];

// -- Reading ------------------------------------------------------------------

/** Reads the tiddler array out of any of the three accepted dump shapes. */
export function tiddlersFromDump(parsed) {
  // twikki-workspace-v1. `keys` mirrors localStorage, so every value is a
  // string — `keys.tiddlers` has to be parsed a second time.
  if (isObject(parsed) && isObject(parsed.keys)) {
    const raw = parsed.keys.tiddlers;
    if (Array.isArray(raw)) return raw.filter(looksLikeTiddler);
    if (typeof raw === 'string') {
      const inner = JSON.parse(raw);
      if (Array.isArray(inner)) return inner.filter(looksLikeTiddler);
    }
    throw new Error('twikki workspace dump has no `keys.tiddlers` array');
  }

  // The Backup plugin's bare array.
  if (Array.isArray(parsed)) return parsed.filter(looksLikeTiddler);

  // An easyDBAccess workspace dump: keep only the tables whose rows are
  // tiddler-shaped, so a mixed workspace doesn't contribute unrelated rows.
  if (isObject(parsed) && Array.isArray(parsed.tables)) {
    return parsed.tables.flatMap((t) => (Array.isArray(t?.rows) ? t.rows.filter(looksLikeTiddler) : []));
  }

  // A single `.table.json`.
  if (isObject(parsed) && Array.isArray(parsed.rows)) return parsed.rows.filter(looksLikeTiddler);

  throw new Error('unrecognized dump — expected a twikki workspace dump, an array of tiddlers, or an easyDBAccess dump');
}

/**
 * A package-imported tiddler is stored WRAPPED: `type: 'json'` and its `text`
 * is the JSON of the real tiddler, which is where the true type, tags and
 * timestamps live (the outer copy has `tags: []` and the import date). Unwrap
 * so the table shows the tiddler, not its serialization. The inner object wins
 * field by field; `package` usually only exists on one of the two.
 */
export function unwrapTiddler(t) {
  if (t.type !== 'json' || typeof t.text !== 'string') return t;
  let inner;
  try {
    inner = JSON.parse(t.text);
  } catch {
    return t; // not a wrapper — e.g. $Settings, whose text is settings JSON
  }
  if (!isObject(inner) || typeof inner.title !== 'string') return t;
  return { ...t, ...inner };
}

// -- Writing ------------------------------------------------------------------

/** Groups tiddlers by their `package`, preserving first-seen package order. */
export function groupByPackage(tiddlers) {
  const groups = new Map();
  for (const t of tiddlers) {
    const pkg = typeof t.package === 'string' && t.package !== '' ? t.package : UNPACKAGED;
    if (!groups.has(pkg)) groups.set(pkg, []);
    groups.get(pkg).push(t);
  }
  return groups;
}

/** One `.table.json` body: the same shape the app's own per-table JSON export
 * writes (`export/table-file.ts`), minus the state a dump can't know. */
export function tiddlersToTableFile(name, tiddlers) {
  const rows = tiddlers.map((t) => ({
    title: text(t.title),
    text: text(t.text),
    tags: tagCell(t.tags),
    type: text(t.type),
    created: text(t.created),
    updated: text(t.updated),
  }));
  // Drop a column no row fills, so a dump without timestamps doesn't import two
  // permanently empty date columns.
  const columns = COLUMNS.filter((c) => c.field === 'title' || rows.some((r) => r[c.field] !== ''));
  const fields = columns.map((c) => c.field);
  return {
    name,
    columns,
    view: 'table',
    rows: rows.map((r) => Object.fromEntries(fields.map((f) => [f, r[f]]))),
  };
}

/**
 * twikki tags are an array; the `array` column type reads a comma list, a JSON
 * array or a real array alike (`util/array-cell.ts`). A comma list is what the
 * app stores, so prefer it — unless a tag contains a comma, which only the JSON
 * spelling survives. Empty members (twikki writes `['']`) are dropped.
 */
function tagCell(tags) {
  const list = (Array.isArray(tags) ? tags : String(tags ?? '').split(',')).map((t) => String(t ?? '').trim()).filter((t) => t !== '');
  if (list.length === 0) return '';
  return list.some((t) => t.includes(',')) ? JSON.stringify(list) : list.join(',');
}

function text(v) {
  return v == null ? '' : String(v);
}

function looksLikeTiddler(v) {
  return isObject(v) && typeof v.title === 'string' && 'text' in v;
}

function isObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Table `code`-style slug, kept in step with `renderer/src/util/ids.ts`. */
function slugTable(s) {
  return (
    s
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'table'
  );
}

// -- CLI ----------------------------------------------------------------------

function parseArgs(argv) {
  const opts = { input: '', out: '', single: false, pkg: '', name: 'tiddlers' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-o' || a === '--out') opts.out = argv[++i] ?? '';
    else if (a === '--single') opts.single = true;
    else if (a === '--package') opts.pkg = argv[++i] ?? '';
    else if (a === '--name') opts.name = argv[++i] ?? 'tiddlers';
    else if (a.startsWith('-')) throw new Error(`unknown option: ${a}`);
    else if (!opts.input) opts.input = a;
    else throw new Error(`unexpected argument: ${a}`);
  }
  if (!opts.input) throw new Error('usage: node scripts/twikki-to-table.mjs <dump.json> [-o <dir>] [--single] [--package <name>] [--name <base>]');
  return opts;
}

function main(argv) {
  const opts = parseArgs(argv);
  const input = resolve(opts.input);
  if (!existsSync(input)) throw new Error(`no such file: ${input}`);
  const outDir = opts.out ? resolve(opts.out) : dirname(input);
  if (!existsSync(outDir) || !statSync(outDir).isDirectory()) throw new Error(`not a directory: ${outDir}`);

  const parsed = JSON.parse(readFileSync(input, 'utf8'));
  const tiddlers = tiddlersFromDump(parsed).map(unwrapTiddler);
  if (tiddlers.length === 0) throw new Error(`no tiddlers found in ${basename(input)}`);

  const groups = opts.single ? new Map([[UNPACKAGED, tiddlers]]) : groupByPackage(tiddlers);
  if (opts.pkg) {
    if (!groups.has(opts.pkg)) throw new Error(`no package "${opts.pkg}" — found: ${[...groups.keys()].map((k) => k || '(none)').join(', ')}`);
    for (const key of [...groups.keys()]) if (key !== opts.pkg) groups.delete(key);
  }

  console.log(`${basename(input)} → ${tiddlers.length} tiddlers, ${groups.size} table${groups.size === 1 ? '' : 's'}`);
  for (const [pkg, list] of groups) {
    const name = pkg ? `${opts.name}-${pkg}` : opts.name;
    const file = resolve(outDir, `${slugTable(name)}.table.json`);
    const body = tiddlersToTableFile(name, list);
    writeFileSync(file, JSON.stringify(body, null, 2));
    console.log(`  ${String(list.length).padStart(5)} rows  ${basename(file)}  [${body.columns.map((c) => c.field).join(', ')}]`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    console.error(`twikki-to-table: ${err.message}`);
    process.exit(1);
  }
}
