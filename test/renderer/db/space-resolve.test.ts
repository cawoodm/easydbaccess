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
  fileIsNewer: false,
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

  it('prefers the browser copy over the folder file', () => {
    // Adopting the folder file means importDb over the browser's copy, and that
    // copy holds anything not yet saved back — boot never reads the user's file.
    expect(decideSpace(evidence({ hasLocalDb: true, inGrantedFolder: true }))).toBe('adopt-local-db');
  });

  it('takes the folder file when it has been written since this copy was made', () => {
    // Two tabs on different origins share the folder and nothing else, so this is
    // the only way the second one ever sees what the first one saved.
    expect(decideSpace(evidence({ hasLocalDb: true, inGrantedFolder: true, fileIsNewer: true }))).toBe('adopt-folder-file');
  });

  it('still prefers the browser copy when this tab has unsaved work', () => {
    // `fileIsNewer` is false whenever the local copy is dirty — see file-stamp's
    // `conflict` verdict, which a sync asks about rather than deciding here.
    expect(decideSpace(evidence({ hasLocalDb: true, inGrantedFolder: true, fileIsNewer: false }))).toBe('adopt-local-db');
  });

  it('does not adopt a newer file that is not in the folder any more', () => {
    expect(decideSpace(evidence({ hasLocalDb: true, inGrantedFolder: false, fileIsNewer: true }))).toBe('adopt-local-db');
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

  it('never asks when something was already found', () => {
    expect(decideSpace(evidence({ hasLocalDb: true, canAskForFolder: true }))).toBe('adopt-local-db');
    expect(decideSpace(evidence({ inGrantedFolder: true, canAskForFolder: true }))).toBe('adopt-folder-file');
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
