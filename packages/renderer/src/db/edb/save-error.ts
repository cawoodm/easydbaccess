/**
 * Turn a failed file write into a sentence that says what to do about it.
 *
 * The File System Access API reports the ordinary causes as `DOMException`s
 * whose messages describe the API's internal state rather than the user's
 * situation. The one that sent us here:
 *
 *   "An operation that depends on state cached in an interface object was made
 *    but the state had changed since it was read from disk."
 *
 * That is Chrome's `InvalidStateError` for `createWritable()`, and what it
 * almost always means in practice is that something else has the file — a
 * SQLite browser, a spreadsheet, a sync client, another tab. The user cannot act
 * on the sentence above; they can act on "check whether it is open somewhere
 * else".
 *
 * Only the causes with an unambiguous reading are translated. Anything else
 * keeps its original message, because a wrong guess about a failure is worse
 * than a technical truth.
 *
 * Two shapes, because two callers: {@link saveErrorMessage} for the blocking
 * alert a manual Save raises, and {@link saveErrorSummary} for the autosave
 * toast, which has one line before it disappears.
 */

/** What went wrong, in the terms the user experiences rather than the API's. */
type Cause = 'busy' | 'gone' | 'other';

/**
 * `InvalidStateError` — the file changed on disk since this handle read it.
 * `NoModificationAllowedError` — a write lock could not be taken.
 * Both mean the same thing to the person at the keyboard: something else has it.
 */
function causeOf(err: unknown): Cause {
  if (!(err instanceof DOMException)) return 'other';
  switch (err.name) {
    case 'InvalidStateError':
    case 'NoModificationAllowedError':
      return 'busy';
    case 'NotFoundError':
      return 'gone';
    default:
      return 'other';
  }
}

/** The file name to put in the message, or a neutral phrase when there isn't one. */
function subject(fileName: string | null): string {
  return fileName === null ? 'The workspace file' : `"${fileName}"`;
}

/**
 * Said after every translated message, and the reason the alert is worth
 * reading to the end: a failed save sounds like lost work, and nothing has been
 * lost. The workspace lives in SQLite and was never in the way of the write.
 */
const NOTHING_LOST = 'Nothing has been lost: your workspace is still here, with its unsaved changes.';

/**
 * The full message for a save that threw — for the blocking alert, where there
 * is room to say what to do next.
 *
 * `fileName` is the file being written, when it is known. The message is much
 * more use when it names the thing to go and close.
 */
export function saveErrorMessage(err: unknown, fileName: string | null = null): string {
  const what = subject(fileName);
  switch (causeOf(err)) {
    case 'busy':
      return (
        `${what} could not be written.\n\n` +
        `Check whether it is open in another program — a SQLite browser, a spreadsheet, ` +
        `a backup or sync tool — or in another tab of this app, then close it and save again.\n\n` +
        `${NOTHING_LOST}`
      );
    case 'gone':
      return `${what} is no longer there.\n\n` + `It may have been moved, renamed or deleted since it was opened. Use Save As to write the workspace somewhere else.\n\n` + `${NOTHING_LOST}`;
    default:
      return `${what} could not be saved: ${message(err)}`;
  }
}

/**
 * One line, for the autosave toast. Same classification, no instructions — a
 * toast that has to be read twice is no better than the cryptic one.
 */
export function saveErrorSummary(err: unknown, fileName: string | null = null): string {
  const what = subject(fileName);
  switch (causeOf(err)) {
    case 'busy':
      return `Autosave could not write ${what} — is it open in another program?`;
    case 'gone':
      return `Autosave could not find ${what} any more.`;
    default:
      return `Autosave failed: ${message(err)}`;
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
