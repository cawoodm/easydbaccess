import { describe, expect, it } from 'vitest';
import { saveErrorMessage, saveErrorSummary } from '../../../packages/renderer/src/db/edb/save-error.js';

/** Chrome's own wording for the failure this module exists to translate. */
const CACHED_STATE = 'An operation that depends on state cached in an interface object was made but the state had changed since it was read from disk.';

const busy = () => new DOMException(CACHED_STATE, 'InvalidStateError');
const locked = () => new DOMException('locked', 'NoModificationAllowedError');
const gone = () => new DOMException('not found', 'NotFoundError');

describe('saveErrorMessage', () => {
  it('replaces the cached-state wording with something to act on', () => {
    const msg = saveErrorMessage(busy(), 'kanban.edb');
    expect(msg).not.toContain('cached in an interface object');
    expect(msg).toContain('"kanban.edb" could not be written');
    expect(msg).toContain('open in another program');
  });

  it('says the work is safe, because a failed save reads as lost work', () => {
    expect(saveErrorMessage(busy(), 'a.edb')).toContain('Nothing has been lost');
  });

  it('treats a failed lock the same way — same thing to the user', () => {
    expect(saveErrorMessage(locked(), 'a.edb')).toContain('open in another program');
  });

  it('names a moved or deleted file as missing, not as busy', () => {
    const msg = saveErrorMessage(gone(), 'a.edb');
    expect(msg).toContain('no longer there');
    expect(msg).toContain('Save As');
    expect(msg).not.toContain('open in another program');
  });

  it('falls back to a neutral subject when the file has no name yet', () => {
    expect(saveErrorMessage(busy())).toContain('The workspace file could not be written');
  });

  it('keeps the original message for a cause it cannot read', () => {
    expect(saveErrorMessage(new Error('disk on fire'), 'a.edb')).toBe('"a.edb" could not be saved: disk on fire');
  });

  it('does not translate an unrelated DOMException', () => {
    expect(saveErrorMessage(new DOMException('nope', 'NotAllowedError'), 'a.edb')).toContain('nope');
  });

  it('copes with a thrown non-Error', () => {
    expect(saveErrorMessage('boom')).toContain('boom');
  });
});

describe('saveErrorSummary', () => {
  it('is one line, with no newlines to be cut off in a toast', () => {
    const msg = saveErrorSummary(busy(), 'a.edb');
    expect(msg).not.toContain('\n');
    expect(msg).toContain('is it open in another program?');
  });

  it('classifies the same way as the full message', () => {
    expect(saveErrorSummary(locked(), 'a.edb')).toContain('another program');
    expect(saveErrorSummary(gone(), 'a.edb')).toContain('could not find');
  });

  it('keeps the original message for anything else', () => {
    expect(saveErrorSummary(new Error('nope'))).toBe('Autosave failed: nope');
  });
});
