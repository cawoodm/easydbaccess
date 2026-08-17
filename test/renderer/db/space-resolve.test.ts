import { describe, expect, it } from 'vitest';
import { decideSpace, spaceFileName, type SpaceEvidence } from '../../../packages/renderer/src/db/edb/space-resolve.js';

/**
 * What `?space=NAME` does when the open database has no such workspace.
 *
 * The rules that matter are the two orderings — the loop guard and the
 * don't-clobber-unsaved-work rule — so each has a scenario of its own rather
 * than being inferred from a table of flags.
 */

/** Nothing found anywhere, no folder obtainable: the old behaviour. */
const NOTHING: SpaceEvidence = {
  inOpenDb: false,
  isActive: false,
  hasLocalDb: false,
  inGrantedFolder: false,
  hasSnapshot: false,
  canAskForFolder: false,
};

const evidence = (over: Partial<SpaceEvidence> = {}): SpaceEvidence => ({ ...NOTHING, ...over });

describe('spaceFileName', () => {
  it('maps a workspace id to the file name chooseEdbTarget suggests', () => {
    expect(spaceFileName('sales')).toBe('sales.edb');
  });
});

describe('decideSpace', () => {
  it('uses what is already open, whatever else exists', () => {
    expect(decideSpace(evidence({ inOpenDb: true, hasLocalDb: true, inGrantedFolder: true }))).toBe('use-open');
  });

  it('creates rather than adopting when the candidate file is already this tab', () => {
    // The loop guard. Every adopt ends in location.reload(), so adopting the file
    // already open would decide the same thing on the next pass, forever.
    expect(decideSpace(evidence({ isActive: true, hasLocalDb: true, inGrantedFolder: true }))).toBe('create');
  });

  it('prefers the browser copy over the folder file', () => {
    // Adopting the folder file means importDb over the browser's copy, and that
    // copy holds anything not yet saved back — boot never reads the user's file.
    expect(decideSpace(evidence({ hasLocalDb: true, inGrantedFolder: true }))).toBe('adopt-local-db');
  });

  it('opens the folder file when this browser holds nothing to lose', () => {
    expect(decideSpace(evidence({ inGrantedFolder: true }))).toBe('adopt-folder-file');
  });

  it('falls back to the IndexedDB dump when there is no file anywhere', () => {
    expect(decideSpace(evidence({ hasSnapshot: true }))).toBe('adopt-snapshot');
  });

  it('prefers a real file to the dump, which is the copy nobody chose a place for', () => {
    expect(decideSpace(evidence({ inGrantedFolder: true, hasSnapshot: true }))).toBe('adopt-folder-file');
    expect(decideSpace(evidence({ hasLocalDb: true, hasSnapshot: true }))).toBe('adopt-local-db');
  });

  it('asks for a folder only when nothing was reachable unprompted', () => {
    expect(decideSpace(evidence({ canAskForFolder: true }))).toBe('ask-for-folder');
  });

  it('does not ask when a dump is already there to use', () => {
    expect(decideSpace(evidence({ hasSnapshot: true, canAskForFolder: true }))).toBe('adopt-snapshot');
  });

  it('does not ask where the browser has no directory picker', () => {
    expect(decideSpace(NOTHING)).toBe('create');
  });

  it('never asks when something was already found', () => {
    expect(decideSpace(evidence({ hasLocalDb: true, canAskForFolder: true }))).toBe('adopt-local-db');
    expect(decideSpace(evidence({ inGrantedFolder: true, canAskForFolder: true }))).toBe('adopt-folder-file');
  });
});
