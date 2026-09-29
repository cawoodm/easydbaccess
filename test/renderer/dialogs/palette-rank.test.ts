import { describe, expect, it } from 'vitest';
import { ELSEWHERE, TITLE_ANYWHERE, TITLE_EXACT, TITLE_START, TITLE_WORD, matchRank, orderByRelevance } from '../../../packages/renderer/src/dialogs/palette-rank.js';

/**
 * The palette matches on a haystack of title + group + keywords + tooltip, which
 * is generous on purpose. What it must not do is ORDER by it: typing `workspace`
 * put Export, Save, Settings and SQL console — four `Actions` buttons that say
 * "workspace" only in a tooltip — above Switch / New / Delete workspace, whose
 * titles say it outright.
 */

const item = (title: string, group: string) => ({ title, group });

/** The group of each row, in order — what the headings are drawn from. */
const runs = (items: Array<{ group: string }>): string[] => items.map((i) => i.group).filter((g, i, all) => g !== all[i - 1]);
const titles = (items: Array<{ title: string }>): string[] => items.map((i) => i.title);

describe('matchRank', () => {
  it('ranks a title that IS the query above one that merely starts with it', () => {
    expect(matchRank('Settings', 'settings')).toBe(TITLE_EXACT);
    expect(matchRank('Settings dialog', 'settings')).toBe(TITLE_START);
    expect(TITLE_EXACT).toBeLessThan(TITLE_START);
  });

  it('ranks a word inside the title above a match in the middle of a word', () => {
    expect(matchRank('Switch workspace', 'workspace')).toBe(TITLE_WORD);
    expect(matchRank('Workspaces', 'spaces')).toBe(TITLE_ANYWHERE);
    expect(TITLE_WORD).toBeLessThan(TITLE_ANYWHERE);
  });

  it('breaks a word on punctuation, not only on a space', () => {
    expect(matchRank('Go to: Sales', 'sales')).toBe(TITLE_WORD);
    expect(matchRank('Re-read folder', 'read')).toBe(TITLE_WORD);
  });

  it('says ELSEWHERE when the title does not carry the query at all', () => {
    // Not "no match" — the item matched on its tooltip or a keyword. It means
    // the reason it matched is not on screen.
    expect(matchRank('Export', 'workspace')).toBe(ELSEWHERE);
  });

  it('ignores case and surrounding space in the query', () => {
    expect(matchRank('New workspace', '  WORKSPACE ')).toBe(TITLE_WORD);
  });

  it('treats an empty query as no title evidence, rather than matching everything', () => {
    expect(matchRank('Anything', '   ')).toBe(ELSEWHERE);
  });
});

describe('orderByRelevance', () => {
  it('puts the titles that carry the word above the ones that only mention it — the reported bug', () => {
    const out = orderByRelevance(
      [
        item('Export', 'Actions'),
        item('Save', 'Actions'),
        item('Settings', 'Actions'),
        item('Switch workspace', 'Workspace'),
        item('New workspace', 'Workspace'),
        item('Delete workspace', 'Workspace'),
      ],
      'workspace',
    );
    expect(titles(out).slice(0, 3)).toEqual(['Switch workspace', 'New workspace', 'Delete workspace']);
    expect(runs(out)).toEqual(['Workspace', 'Actions']);
  });

  it('keeps every group in ONE run, or the palette draws its heading twice', () => {
    const out = orderByRelevance([item('Go to: workspace notes', 'Tables'), item('Switch workspace', 'Workspace'), item('Go to: other', 'Tables')], 'workspace');
    expect(runs(out).filter((g) => g === 'Tables')).toHaveLength(1);
  });

  it('moves a whole group on its BEST item, so one strong match carries its weaker siblings', () => {
    const out = orderByRelevance([item('Export', 'Actions'), item('Save workspace', 'Actions'), item('Delete workspace', 'Workspace')], 'workspace');
    // `Actions` leads because `Save workspace` is a word match, and `Export` —
    // which matched on its tooltip — travels with its group rather than
    // splitting it.
    expect(runs(out)).toEqual(['Actions', 'Workspace']);
    expect(titles(out)).toEqual(['Save workspace', 'Export', 'Delete workspace']);
  });

  it('falls back to the empty-palette group order when two groups match equally well', () => {
    const out = orderByRelevance([item('Workspace notes', 'Tables'), item('Workspace layout', 'Windows')], 'workspace');
    // Both are TITLE_START, so `groupRank` decides — Windows (0) before Tables (3).
    expect(runs(out)).toEqual(['Windows', 'Tables']);
  });

  it('keeps arrival order inside a group, so Recent stays newest-first', () => {
    const out = orderByRelevance([item('Tile', 'Recent'), item('Cascade', 'Recent'), item('Close all', 'Recent')], 'windows');
    // None of the three has the word in its title, so nothing reorders them.
    expect(titles(out)).toEqual(['Tile', 'Cascade', 'Close all']);
  });

  it('lets a title match beat Recent, which is the same complaint one row down', () => {
    const out = orderByRelevance([item('Tile', 'Recent'), item('Switch workspace', 'Workspace')], 'workspace');
    expect(titles(out)).toEqual(['Switch workspace', 'Tile']);
  });

  it('returns an empty list unchanged', () => {
    expect(orderByRelevance([], 'workspace')).toEqual([]);
  });
});
