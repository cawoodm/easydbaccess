import { describe, expect, it } from 'vitest';
import { decideActiveFileSync, describeActiveOutcome, type ActiveFileOutcome } from '../../../packages/renderer/src/db/edb/active-file-sync.js';
import type { FileVerdict } from '../../../packages/renderer/src/db/edb/file-stamp.js';

const VERDICTS: FileVerdict[] = ['same', 'file-newer', 'conflict', 'ahead', 'unknown'];

describe('decideActiveFileSync', () => {
  it('does nothing when the file is not in the folder, whatever the verdict says', () => {
    // A missing file and a file we have never read both answer `unknown`, so the
    // presence of the file is asked separately. There is nothing to offer about a
    // file that is not there.
    for (const v of VERDICTS) expect(decideActiveFileSync(v, false)).toBe('nothing');
  });

  it('asks before loading a file that moved on', () => {
    // Nothing here is unsaved, so the load destroys nothing — but it does replace
    // what is on screen, and the user asked to be told first.
    expect(decideActiveFileSync('file-newer', true)).toBe('ask-load');
  });

  it('asks which copy to keep when both sides moved', () => {
    expect(decideActiveFileSync('conflict', true)).toBe('ask-conflict');
  });

  it('asks rather than shrugging when the two cannot be compared', () => {
    // The bug this fixes: `unknown` returned in silence, so a Sync looked like it
    // had done nothing. It is reached by ordinary use — an Overwrite used to clear
    // the stamp the comparison needs.
    expect(decideActiveFileSync('unknown', true)).toBe('ask-unknown');
  });

  it('leaves a file that is as we left it, and one we are ahead of', () => {
    expect(decideActiveFileSync('same', true)).toBe('nothing');
    // Being ahead wants a Save, not a Sync.
    expect(decideActiveFileSync('ahead', true)).toBe('nothing');
  });

  it('never returns anything but the four answers', () => {
    const allowed = new Set(['nothing', 'ask-load', 'ask-conflict', 'ask-unknown']);
    for (const v of VERDICTS) for (const there of [true, false]) expect(allowed.has(decideActiveFileSync(v, there))).toBe(true);
  });
});

describe('describeActiveOutcome', () => {
  it('names the file in every clause it produces', () => {
    const spoken: ActiveFileOutcome[] = ['in-step', 'ours-ahead', 'loaded', 'kept', 'overwritten'];
    for (const o of spoken) expect(describeActiveOutcome(o, 'sales.edb')).toContain('sales.edb');
  });

  it('says nothing about a file that plays no part', () => {
    // A tab on the browser's own database has no file, and a file outside this
    // folder is not this sync's business. Naming either in every toast is noise.
    expect(describeActiveOutcome('no-file', '')).toBe('');
    expect(describeActiveOutcome('missing', 'sales.edb')).toBe('');
  });

  it('leads with a space, so it appends to the report sentence', () => {
    expect(describeActiveOutcome('in-step', 'a.edb').startsWith(' ')).toBe(true);
  });
});
