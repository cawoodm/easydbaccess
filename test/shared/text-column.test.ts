import { describe, expect, it } from 'vitest';
import { looksLikeTextColumn, TEXT_MIN_LEN, TEXT_RUN } from '../../packages/shared/src/text-column.js';

const LONG = 'x'.repeat(TEXT_MIN_LEN);
const SHORT = 'open';

describe('looksLikeTextColumn', () => {
  it('is false for an empty column', () => {
    expect(looksLikeTextColumn([])).toBe(false);
  });

  it('needs a run of long cells, not just one', () => {
    // One pasted essay in a column of statuses must not retype the column.
    expect(looksLikeTextColumn([SHORT, SHORT, LONG, SHORT, SHORT, SHORT])).toBe(false);
  });

  it('is true once TEXT_RUN long cells are consecutive', () => {
    expect(looksLikeTextColumn([SHORT, ...Array(TEXT_RUN).fill(LONG), SHORT])).toBe(true);
  });

  it('breaks the run on a short cell', () => {
    const values = [LONG, LONG, SHORT, LONG, LONG, SHORT, LONG, LONG];
    expect(looksLikeTextColumn(values)).toBe(false);
  });

  it('accepts a short column where every value is long', () => {
    // Same concession `looksLikeArrayColumn` makes: a two-row import cannot
    // produce a run of five, and the evidence it does have is unanimous.
    expect(looksLikeTextColumn([LONG, LONG])).toBe(true);
    expect(looksLikeTextColumn([LONG, SHORT])).toBe(false);
  });

  it('measures the trimmed length', () => {
    const padded = `   ${'y'.repeat(TEXT_MIN_LEN - 1)}   `;
    expect(looksLikeTextColumn([padded, padded])).toBe(false);
  });

  it('ignores non-strings however long they print', () => {
    // A 200-digit number is a number, and an object's JSON length says nothing
    // about text a reader sees.
    const bigNumber = Number('1'.repeat(20));
    const bigObject = { note: 'z'.repeat(TEXT_MIN_LEN) };
    expect(looksLikeTextColumn([bigNumber, bigNumber])).toBe(false);
    expect(looksLikeTextColumn([bigObject, bigObject])).toBe(false);
  });

  it('takes a threshold from the caller', () => {
    expect(looksLikeTextColumn(['abcdef', 'abcdef'], 5)).toBe(true);
    expect(looksLikeTextColumn(['abcdef', 'abcdef'], 50)).toBe(false);
  });
});
