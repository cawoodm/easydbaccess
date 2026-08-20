import { describe, expect, it } from 'vitest';
import { compareCopies, describeCopy, formatBytes, formatWhen, sizeChangeNote } from '../../../packages/renderer/src/db/edb/copy-facts.js';

/**
 * What the "which copy do you want to keep?" prompts say about each copy.
 *
 * The prompts used to name the workspace and nothing else, and two copies of
 * `sales` are indistinguishable on a name — so the answer was a guess, and one of
 * the two answers destroys work. Everything here is about making the two copies
 * tellable apart.
 */
describe('describeCopy', () => {
  it('reads like a file manager: tables, size, when it was written', () => {
    const line = describeCopy({ tables: 3, size: 131072, mtime: Date.UTC(2026, 7, 19, 12, 30) }, 'en-GB');
    expect(line).toContain('3 tables');
    expect(line).toContain('128 KB');
    expect(line).toContain('saved ');
    expect(line).toContain('2026');
  });

  it('counts one table as a table', () => {
    expect(describeCopy({ tables: 1 })).toBe('1 table');
  });

  it('leaves out what this side could not count, rather than calling it zero', () => {
    // A count that could not be taken is NOT a count of none: "0 tables" about a
    // workspace full of them is the one thing worse than saying nothing.
    expect(describeCopy({ size: 2048 })).toBe('2 KB');
    expect(describeCopy({})).toBe('');
  });

  it('says nothing about views when there are none', () => {
    expect(describeCopy({ tables: 2, views: 0 })).toBe('2 tables');
    expect(describeCopy({ tables: 2, views: 1 })).toBe('2 tables, 1 view');
  });

  it('leads with the workspace count, for a question about a whole file', () => {
    expect(describeCopy({ workspaces: 2, tables: 7 })).toBe('2 workspaces, 7 tables');
  });
});

describe('formatBytes', () => {
  it('uses the unit a file manager would', () => {
    expect(formatBytes(0)).toBe('0 bytes');
    expect(formatBytes(1)).toBe('1 byte');
    expect(formatBytes(999)).toBe('999 bytes');
    expect(formatBytes(1024)).toBe('1 KB');
    expect(formatBytes(131072)).toBe('128 KB');
    expect(formatBytes(42 * 1024 * 1024)).toBe('42.0 MB');
  });
});

describe('formatWhen', () => {
  it('shows the date and the time, and no seconds', () => {
    const when = formatWhen(Date.UTC(2026, 7, 19, 12, 30, 45), 'en-GB');
    expect(when).toContain('2026');
    // Seconds are noise in a dialog read at a glance.
    expect(when).not.toContain('45');
  });
});

describe('compareCopies', () => {
  it('puts each side on its own line, under the question', () => {
    const block = compareCopies([
      { label: 'In this browser', facts: { tables: 2 } },
      { label: 'sales.edb', facts: { tables: 5, size: 1024 } },
    ]);
    expect(block).toBe('\n\nIn this browser: 2 tables\nsales.edb: 5 tables, 1 KB');
  });

  it('drops a side it knows nothing about, and keeps the other', () => {
    // The file's numbers are the ones the reader cannot otherwise see, so a lone
    // line still helps.
    expect(
      compareCopies([
        { label: 'In this browser', facts: {} },
        { label: 'sales.edb', facts: { tables: 5 } },
      ]),
    ).toBe('\n\nsales.edb: 5 tables');
  });

  it('is empty when neither side has anything, so the question stays a sentence', () => {
    expect(
      compareCopies([
        { label: 'a', facts: {} },
        { label: 'b', facts: {} },
      ]),
    ).toBe('');
  });
});

describe('sizeChangeNote', () => {
  it('says what the file used to be, when the size moved', () => {
    expect(sizeChangeNote(98304, 131072)).toBe('\n\nIt was 96 KB when this tab last read it.');
  });

  it('says nothing when the size is the same or unknown', () => {
    // A timestamp alone says nothing — a save that rewrote the same data moves it
    // too — so an unchanged size is not worth a sentence.
    expect(sizeChangeNote(131072, 131072)).toBe('');
    expect(sizeChangeNote(undefined, 131072)).toBe('');
    expect(sizeChangeNote(98304, undefined)).toBe('');
  });
});
