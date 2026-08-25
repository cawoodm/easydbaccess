import { describe, expect, it } from 'vitest';
import { nameList, unmentionedPlugins } from '../../../packages/renderer/src/plugins/new-plugins.js';
import type { CatalogResolved } from '../../../packages/renderer/src/plugin-host/plugin-catalog.js';

/**
 * Which catalog plugins are worth mentioning on boot.
 *
 * The failure mode of a boot prompt is nagging, so the rule has to be narrow in
 * three directions at once: installed now, ever held here, already mentioned.
 */

const entry = (id: string, absUrl = `https://app.test/plugins/${id}.js`): CatalogResolved => ({ id, name: id.replace(/-/g, ' '), url: `./${id}.js`, absUrl });

const CATALOG = [entry('cell-email'), entry('cell-image-url'), entry('header-clock')];
const none = new Set<string>();

describe('unmentionedPlugins', () => {
  it('offers everything when nothing is installed and nothing has been said', () => {
    expect(unmentionedPlugins(CATALOG, none, none, none).map((e) => e.id)).toEqual(['cell-email', 'cell-image-url', 'header-clock']);
  });

  it('leaves out what is installed now', () => {
    const installed = new Set(['https://app.test/plugins/header-clock.js']);
    expect(unmentionedPlugins(CATALOG, installed, none, none).map((e) => e.id)).toEqual(['cell-email', 'cell-image-url']);
  });

  it('leaves out what this browser has EVER held', () => {
    // The "never have been" half. A plugin installed once and removed has a record
    // in the `plugins` collection but is not in `pluginUrls` — offering it again
    // would be arguing with a decision the user already made.
    const known = new Set(['https://app.test/plugins/cell-email.js']);
    expect(unmentionedPlugins(CATALOG, none, known, none).map((e) => e.id)).toEqual(['cell-image-url', 'header-clock']);
  });

  it('leaves out what has already been mentioned', () => {
    const mentioned = new Set(['https://app.test/plugins/cell-email.js', 'https://app.test/plugins/header-clock.js']);
    expect(unmentionedPlugins(CATALOG, none, none, mentioned).map((e) => e.id)).toEqual(['cell-image-url']);
  });

  it('is empty once every entry is accounted for — the quiet boot', () => {
    const mentioned = new Set(CATALOG.map((e) => e.absUrl));
    expect(unmentionedPlugins(CATALOG, none, none, mentioned)).toEqual([]);
  });

  it('counts one URL once, however many catalogs offer it', () => {
    // Two catalogs listing the same file is one plugin, and installing it once
    // satisfies both. An id would not answer this — two catalogs may each have a
    // `cell-email` of their own.
    const twice = [entry('cell-email'), entry('cell-email')];
    expect(unmentionedPlugins(twice, none, none, none)).toHaveLength(1);
  });

  it('tells two entries with the same id apart by URL', () => {
    const mine = entry('cell-email', 'https://mine.test/cell-email.js');
    const theirs = entry('cell-email', 'https://theirs.test/cell-email.js');
    const installed = new Set([mine.absUrl]);
    expect(unmentionedPlugins([mine, theirs], installed, none, none).map((e) => e.absUrl)).toEqual([theirs.absUrl]);
  });

  it('keeps the catalog order, so the sentence reads as the list does', () => {
    expect(unmentionedPlugins(CATALOG, none, none, none)[0]?.id).toBe('cell-email');
  });
});

describe('nameList', () => {
  it('reads as a sentence, not as an array', () => {
    expect(nameList([entry('a')])).toBe('a');
    expect(nameList([entry('a'), entry('b')])).toBe('a and b');
    expect(nameList([entry('a'), entry('b'), entry('c')])).toBe('a, b and c');
  });

  it('counts the tail rather than listing a catalog into a dialog', () => {
    const many = ['a', 'b', 'c', 'd', 'e'].map((id) => entry(id));
    expect(nameList(many)).toBe('a, b and c, and 2 more');
  });

  it('is empty for nothing, so no caller prints a stray comma', () => {
    expect(nameList([])).toBe('');
  });
});
