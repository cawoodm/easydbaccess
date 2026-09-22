import { describe, expect, it, vi } from 'vitest';
import { COMPARE_COPIES, KEEP_BROWSER_COPY, OPEN_FILE_COPY, askWhichCopy, confirmDataLoss, copyChoiceOf, whyAsking } from '../../../packages/renderer/src/db/edb/copy-choice.js';

/**
 * The question asked when this browser and the folder each hold a copy of the
 * workspace being opened.
 *
 * Until v0.0.462 there was no question: `decideSpace` kept whichever copy the
 * browser happened to hold, so a workspace whose only real copy was the file
 * opened with no tables. See `docs/tech/EDB.md`.
 */

/** A `Dialogs` that records what it was asked and answers as told. */
function dialogs(answers: { choice?: string | null; confirm?: boolean } = {}) {
  const asked: { choice: string[]; confirm: string[] } = { choice: [], confirm: [] };
  return {
    asked,
    api: {
      alert: vi.fn(async () => undefined),
      confirm: vi.fn(async (message: string) => {
        asked.confirm.push(message);
        return answers.confirm ?? false;
      }),
      prompt: vi.fn(async () => null),
      choice: vi.fn(async (message: string, _options: string[], _title?: string) => {
        asked.choice.push(message);
        return answers.choice ?? null;
      }),
      toast: vi.fn(),
    },
  };
}

describe('copyChoiceOf', () => {
  it('reads each answer off the button that was pressed', () => {
    expect(copyChoiceOf(OPEN_FILE_COPY)).toBe('file');
    expect(copyChoiceOf(KEEP_BROWSER_COPY)).toBe('browser');
    expect(copyChoiceOf(COMPARE_COPIES)).toBe('compare');
  });

  it('treats a dismissed dialog as touching nothing', () => {
    // The only answer that is safe to infer from silence, and the reason there is
    // no Cancel among the three buttons.
    expect(copyChoiceOf(null)).toBe('none');
    expect(copyChoiceOf('something else entirely')).toBe('none');
  });
});

describe('whyAsking', () => {
  it('says the file moved on when that is what happened', () => {
    expect(whyAsking('file-newer', 'sales.edb')).toContain('written since');
  });

  it('names both sides having moved as the conflict it is', () => {
    const said = whyAsking('conflict', 'sales.edb');
    expect(said).toContain('written since');
    expect(said).toContain('changes of its own');
  });

  it('says outright that it cannot tell, rather than implying a fault', () => {
    // The common case and the one that used to be silent: no stamp, because a
    // stamp only exists on the origin that imported or wrote the file.
    expect(whyAsking('unknown', 'sales.edb')).toContain('cannot tell which is newer');
  });

  it('always names the file, because that is the part the user can act on', () => {
    for (const verdict of ['file-newer', 'conflict', 'unknown'] as const) {
      expect(whyAsking(verdict, 'northwind.edb')).toContain('northwind.edb');
    }
  });
});

describe('askWhichCopy', () => {
  const sides = { here: { tables: 3, views: 1 }, there: { tables: 9, views: 4, size: 7_061_504, mtime: 1_787_000_000_000 } };

  it('puts both copies in the question, so the answer is not a guess', async () => {
    const d = dialogs({ choice: KEEP_BROWSER_COPY });
    await askWhichCopy(d.api, { file: 'northwind.edb', verdict: 'unknown', ...sides });
    const message = d.asked.choice[0] ?? '';
    expect(message).toContain('In this browser: 3 tables');
    expect(message).toContain('northwind.edb: 9 tables');
  });

  it('offers the three answers in the order that names the file first', async () => {
    const d = dialogs({ choice: OPEN_FILE_COPY });
    expect(await askWhichCopy(d.api, { file: 'northwind.edb', verdict: 'unknown', ...sides })).toBe('file');
    expect(d.api.choice.mock.calls[0]?.[1]).toEqual([OPEN_FILE_COPY, KEEP_BROWSER_COPY, COMPARE_COPIES]);
  });

  it('asks again before an empty copy is kept over a full one', async () => {
    // The whole point. Keeping nothing over 9 tables is almost certainly a slip,
    // and the three buttons cannot carry that warning themselves.
    const d = dialogs({ choice: KEEP_BROWSER_COPY, confirm: false });
    const answer = await askWhichCopy(d.api, { file: 'northwind.edb', verdict: 'unknown', here: { tables: 0, views: 0 }, there: { tables: 9, views: 4 } });
    expect(d.asked.confirm).toHaveLength(1);
    expect(answer).toBe('none');
  });

  it('carries the answer through when the user confirms the loss anyway', async () => {
    const d = dialogs({ choice: KEEP_BROWSER_COPY, confirm: true });
    expect(await askWhichCopy(d.api, { file: 'northwind.edb', verdict: 'unknown', here: { tables: 0, views: 0 }, there: { tables: 9, views: 4 } })).toBe('browser');
  });

  it('does not warn about comparing, which loses nothing by construction', async () => {
    const d = dialogs({ choice: COMPARE_COPIES });
    expect(await askWhichCopy(d.api, { file: 'northwind.edb', verdict: 'unknown', here: { tables: 0, views: 0 }, there: { tables: 9, views: 4 } })).toBe('compare');
    expect(d.asked.confirm).toHaveLength(0);
  });

  it('says what the file used to weigh, when this browser once agreed with it', async () => {
    const d = dialogs({ choice: KEEP_BROWSER_COPY });
    await askWhichCopy(d.api, { file: 'northwind.edb', verdict: 'file-newer', ...sides, knownSize: 4_000_000 });
    expect(d.asked.choice[0]).toContain('when this tab last read it');
  });
});

describe('confirmDataLoss', () => {
  it('asks nothing when neither side is empty', async () => {
    const d = dialogs();
    expect(await confirmDataLoss(d.api, 'sales.edb', { tables: 2 }, { tables: 3 }, 'the other copy')).toBe(true);
    expect(d.asked.confirm).toHaveLength(0);
  });

  it('asks nothing when a count could not be taken', async () => {
    // An absent count is not a count of none, or the guard would cry wolf on
    // every browser that could not count and train the user to click past it.
    const d = dialogs();
    expect(await confirmDataLoss(d.api, 'sales.edb', {}, { tables: 3 }, 'the other copy')).toBe(true);
    expect(d.asked.confirm).toHaveLength(0);
  });

  it('names what is being lost, in the units the user can check', async () => {
    const d = dialogs({ confirm: true });
    expect(await confirmDataLoss(d.api, 'sales.edb', { tables: 0, views: 0 }, { tables: 1, views: 2 }, 'the copy in sales.edb')).toBe(true);
    expect(d.asked.confirm[0]).toContain('1 table and 2 views');
  });
});
