import { describe, expect, it } from 'vitest';
import { decideSpace, mayCreateWorkspaceIn, slugifyWorkspace, spaceFileName, workspaceIdFromFileName, type SpaceEvidence } from '../../../packages/renderer/src/db/edb/space-resolve.js';

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
  // No stamp: we have never read that file on this origin. The default, because
  // it is what every new origin, profile and machine starts from.
  verdict: 'unknown',
  canAskForFolder: false,
};

const evidence = (over: Partial<SpaceEvidence> = {}): SpaceEvidence => ({ ...NOTHING, ...over });

describe('spaceFileName', () => {
  it('maps a workspace id to the file name a Save writes', () => {
    expect(spaceFileName('sales')).toBe('sales.edb');
  });
});

/**
 * The other direction: Open `a.edb` lands in the workspace `a`.
 *
 * Opening used to reload with no `?space=` at all, so boot fell back to the
 * device-global last-workspace id and then to the file's first record — which is
 * how opening `a.edb` could show a workspace called `default`.
 */
describe('workspaceIdFromFileName', () => {
  it('is the file name without its extension', () => {
    expect(workspaceIdFromFileName('sales.edb')).toBe('sales');
  });

  it('lower-cases, because a workspace id is a slug and Windows names are not', () => {
    expect(workspaceIdFromFileName('Sales.EDB')).toBe('sales');
  });

  it('takes the name out of a path the picker handed over', () => {
    expect(workspaceIdFromFileName('C:/Users/marc/data/sales.edb')).toBe('sales');
  });

  it('slugifies a name that is not one already, so the id matches what a new workspace would get', () => {
    expect(workspaceIdFromFileName('My Data.edb')).toBe(slugifyWorkspace('My Data'));
    expect(workspaceIdFromFileName('My Data.edb')).toBe('my-data');
  });

  it('falls back rather than returning an empty id', () => {
    expect(workspaceIdFromFileName('.edb')).toBe('default');
  });

  it('round-trips with spaceFileName', () => {
    expect(workspaceIdFromFileName(spaceFileName('sales'))).toBe('sales');
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

  it('keeps the browser copy without asking when the file is exactly as we left it', () => {
    // `same` is the only verdict that PROVES the two copies are one thing, so it
    // is the only one that may be settled in silence.
    expect(decideSpace(evidence({ hasLocalDb: true, inGrantedFolder: true, verdict: 'same' }))).toBe('adopt-local-db');
  });

  it('keeps the browser copy without asking when this tab holds unsaved work', () => {
    // `ahead` is the file plus work. Taking the file would throw the work away,
    // and there is nothing on the file's side to weigh against it.
    expect(decideSpace(evidence({ hasLocalDb: true, inGrantedFolder: true, verdict: 'ahead' }))).toBe('adopt-local-db');
  });

  it('takes the file when it has been written since this copy was made', () => {
    // The mirror image of `ahead`: the file is this copy plus work, so taking it
    // loses nothing — and it is the only way two origins sharing a folder ever
    // converge, since everything but the folder is origin-scoped.
    expect(decideSpace(evidence({ hasLocalDb: true, inGrantedFolder: true, verdict: 'file-newer' }))).toBe('adopt-folder-file');
  });

  it('asks when both copies moved', () => {
    expect(decideSpace(evidence({ hasLocalDb: true, inGrantedFolder: true, verdict: 'conflict' }))).toBe('ask-which-copy');
  });

  it('asks when there is no stamp, rather than keeping whatever the browser holds', () => {
    // The whole bug: a stamp only exists on the origin that imported or wrote the
    // file, so `unknown` is every new origin — and the browser's copy of that name
    // may be the empty database a boot creates when the pool is asked for a file
    // it does not hold. That copy used to win in silence.
    expect(decideSpace(evidence({ hasLocalDb: true, inGrantedFolder: true, verdict: 'unknown' }))).toBe('ask-which-copy');
  });

  it('does not ask about a file that is not in the folder any more', () => {
    // Nothing to compare with and nothing to offer: the browser's copy is all
    // there is.
    expect(decideSpace(evidence({ hasLocalDb: true, inGrantedFolder: false, verdict: 'file-newer' }))).toBe('adopt-local-db');
    expect(decideSpace(evidence({ hasLocalDb: true, inGrantedFolder: false, verdict: 'unknown' }))).toBe('adopt-local-db');
  });

  it('opens the folder file when this browser holds nothing to lose', () => {
    expect(decideSpace(evidence({ inGrantedFolder: true }))).toBe('adopt-folder-file');
  });

  it('asks for a folder only when nothing was reachable unprompted', () => {
    expect(decideSpace(evidence({ canAskForFolder: true }))).toBe('ask-for-folder');
  });

  it('does not ask where the browser has no directory picker', () => {
    expect(decideSpace(NOTHING)).toBe('create');
  });

  it('never asks for a folder when something was already found', () => {
    expect(decideSpace(evidence({ hasLocalDb: true, canAskForFolder: true }))).toBe('adopt-local-db');
    expect(decideSpace(evidence({ inGrantedFolder: true, canAskForFolder: true }))).toBe('adopt-folder-file');
  });

  it('opens the folder file with no question when this browser holds no copy at all', () => {
    // One copy is not a choice. The question only exists where both sides have
    // something that could be lost.
    for (const verdict of ['same', 'ahead', 'file-newer', 'conflict', 'unknown'] as const) {
      expect(decideSpace(evidence({ inGrantedFolder: true, verdict }))).toBe('adopt-folder-file');
    }
  });
});

/**
 * WHERE a workspace that exists nowhere may be created.
 *
 * `decideSpace` says what to look for; this says where a create may land, and it
 * is checked at the single line that creates one (`app-context.ts`). Four routes
 * reach that line and three of them used to create the workspace inside whichever
 * `.edb` the tab had open — a file named after one workspace, holding two.
 */
describe('mayCreateWorkspaceIn', () => {
  it('lets the project index hold any workspace: that is what it is for', () => {
    expect(mayCreateWorkspaceIn('index.edp', 'zz')).toBe(true);
    expect(mayCreateWorkspaceIn('index.edp', 'alpha')).toBe(true);
  });

  it('lets a .edb hold the workspace its name says, and only that one', () => {
    // The empty file New workspace → Advanced just wrote, whose workspace record
    // this boot is about to create.
    expect(mayCreateWorkspaceIn('alpha.edb', 'alpha')).toBe(true);
    expect(mayCreateWorkspaceIn('alpha.edb', 'zz')).toBe(false);
  });

  it('compares by the same slug rule the file name is built from', () => {
    expect(mayCreateWorkspaceIn('My Data.edb', 'my-data')).toBe(true);
    expect(mayCreateWorkspaceIn('ALPHA.EDB', 'alpha')).toBe(true);
  });

  it('does not treat some other extension as a one-workspace file', () => {
    // Only `.edb` carries the rule. Anything else is this browser's own database.
    expect(mayCreateWorkspaceIn('whatever.sqlite', 'zz')).toBe(true);
  });
});
