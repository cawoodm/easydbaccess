import { describe, expect, it } from 'vitest';
import { RECENT_GROUP, orderByRecent, pushRecent, readRecent } from '../../../packages/renderer/src/dialogs/palette-recent.js';

const item = (id: string, group = 'Actions') => ({ id, group });

describe('pushRecent', () => {
  it('puts the newest id first', () => {
    expect(pushRecent(['a'], 'b')).toEqual(['b', 'a']);
  });

  it('moves an id that is already remembered instead of repeating it', () => {
    expect(pushRecent(['a', 'b', 'c'], 'c')).toEqual(['c', 'a', 'b']);
  });

  it('keeps at most five ids', () => {
    expect(pushRecent(['a', 'b', 'c', 'd', 'e'], 'f')).toEqual(['f', 'a', 'b', 'c', 'd']);
  });
});

describe('readRecent', () => {
  it('reads an id list back', () => {
    expect(readRecent(['a', 'b'])).toEqual(['a', 'b']);
  });

  it('returns nothing for an absent or non-list value', () => {
    expect(readRecent(undefined)).toEqual([]);
    expect(readRecent('a')).toEqual([]);
    expect(readRecent([1, 'a', null])).toEqual(['a']);
  });
});

describe('orderByRecent', () => {
  it('moves the remembered commands to the front, newest first', () => {
    const out = orderByRecent([item('a'), item('b'), item('c')], ['c', 'a']);
    expect(out.map((i) => i.id)).toEqual(['c', 'a', 'b']);
  });

  it('re-groups the moved commands under Recent', () => {
    const out = orderByRecent([item('a', 'Tables'), item('b')], ['a']);
    expect(out[0]!.group).toBe(RECENT_GROUP);
    expect(out[1]!.group).toBe('Actions');
  });

  it('lists a command once — it moves, it is not copied', () => {
    const out = orderByRecent([item('a'), item('b')], ['a']);
    expect(out.filter((i) => i.id === 'a')).toHaveLength(1);
  });

  it('skips an id that no longer resolves to an item', () => {
    // The table a "Go to" command pointed at was deleted since.
    const out = orderByRecent([item('a'), item('b')], ['goto:gone', 'b']);
    expect(out.map((i) => i.id)).toEqual(['b', 'a']);
  });

  it('leaves the list untouched when nothing is remembered', () => {
    const items = [item('a'), item('b')];
    expect(orderByRecent(items, [])).toBe(items);
  });
});
