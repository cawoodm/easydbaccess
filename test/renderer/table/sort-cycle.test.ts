import { describe, expect, it } from 'vitest';
import type { SortSpec } from '@easydb/shared';
import { nextSortSpecs } from '../../../packages/renderer/src/table/sort-cycle.js';

const asc = (field: string): SortSpec => ({ field, asc: true });
const desc = (field: string): SortSpec => ({ field, asc: false });

describe('nextSortSpecs — descending first (the default)', () => {
  const o = { descFirst: true };

  it('a first click sorts descending', () => {
    expect(nextSortSpecs([], 'age', o)).toEqual([desc('age')]);
  });

  it('the second click flips to ascending, the third turns it off', () => {
    const one = nextSortSpecs([], 'age', o);
    const two = nextSortSpecs(one, 'age', o);
    expect(two).toEqual([asc('age')]);
    expect(nextSortSpecs(two, 'age', o)).toEqual([]);
  });

  it('clicking a different column replaces the sort rather than adding to it', () => {
    expect(nextSortSpecs([desc('age')], 'city', o)).toEqual([desc('city')]);
  });

  it('clicking a column that is one of SEVERAL keys makes it the only one', () => {
    // Not the cycle: with other keys in play a plain click means "sort by this
    // instead", so it starts over in the first direction.
    expect(nextSortSpecs([asc('city'), desc('age')], 'age', o)).toEqual([desc('age')]);
  });
});

describe('nextSortSpecs — ascending first (the setting turned off)', () => {
  const o = { descFirst: false };

  it('a first click sorts ascending, and the cycle mirrors', () => {
    const one = nextSortSpecs([], 'age', o);
    expect(one).toEqual([asc('age')]);
    const two = nextSortSpecs(one, 'age', o);
    expect(two).toEqual([desc('age')]);
    expect(nextSortSpecs(two, 'age', o)).toEqual([]);
  });

  it('defaults to ascending-first when no option is passed at all', () => {
    expect(nextSortSpecs([], 'age')).toEqual([asc('age')]);
  });
});

describe('nextSortSpecs — shift-click adds a key behind the others', () => {
  const o = { additive: true, descFirst: true };

  it('keeps the existing keys and appends the new one', () => {
    expect(nextSortSpecs([asc('city')], 'age', o)).toEqual([asc('city'), desc('age')]);
  });

  it('cycles a key already in the list without moving the others', () => {
    const start = [asc('city'), desc('age')];
    expect(nextSortSpecs(start, 'age', o)).toEqual([asc('city'), asc('age')]);
  });

  it('drops just that key on its third state, leaving the rest sorted', () => {
    // With descending first, ASCENDING is the last state before off.
    const start = [asc('city'), asc('age')];
    expect(nextSortSpecs(start, 'age', o)).toEqual([asc('city')]);
  });

  it('moves a cycled key to the back — its priority is where it was re-clicked', () => {
    // Shift-clicking a key rebuilds it at the end of the list. Worth pinning:
    // the order of the array IS the sort priority.
    const start = [desc('age'), asc('city')];
    expect(nextSortSpecs(start, 'age', o)).toEqual([asc('city'), asc('age')]);
  });

  it('does not mutate the array it was given', () => {
    const start = [asc('city')];
    nextSortSpecs(start, 'age', o);
    expect(start).toEqual([asc('city')]);
  });
});
