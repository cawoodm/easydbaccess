import { describe, expect, it } from 'vitest';
import { isUnsafeIntegerText, quoteBigIntegers } from '../../../packages/renderer/src/import/big-numbers.js';

/** The reported value: a snowflake id that reads back as …894200 as a number. */
const BIG = '1298624375692894210';

describe('isUnsafeIntegerText', () => {
  it('flags an integer past 2^53', () => {
    expect(isUnsafeIntegerText(BIG)).toBe(true);
    // Proof of the damage it exists to prevent.
    expect(String(Number(BIG))).not.toBe(BIG);
  });

  it('accepts every integer a JS number holds exactly', () => {
    expect(isUnsafeIntegerText('0')).toBe(false);
    expect(isUnsafeIntegerText('42')).toBe(false);
    expect(isUnsafeIntegerText('-42')).toBe(false);
    expect(isUnsafeIntegerText(String(Number.MAX_SAFE_INTEGER))).toBe(false);
    expect(isUnsafeIntegerText(String(Number.MIN_SAFE_INTEGER))).toBe(false);
  });

  it('flags one past the boundary, either sign', () => {
    expect(isUnsafeIntegerText('9007199254740992')).toBe(true);
    expect(isUnsafeIntegerText('-9007199254740992')).toBe(true);
  });

  it('judges integers only — a decimal is a measurement, not an id', () => {
    expect(isUnsafeIntegerText('1.5')).toBe(false);
    expect(isUnsafeIntegerText('1e400')).toBe(false);
    expect(isUnsafeIntegerText('12986243756928942.10')).toBe(false);
  });

  it('says no to anything that is not an integer literal', () => {
    expect(isUnsafeIntegerText('')).toBe(false);
    expect(isUnsafeIntegerText('   ')).toBe(false);
    expect(isUnsafeIntegerText('abc')).toBe(false);
    expect(isUnsafeIntegerText(`id ${BIG}`)).toBe(false);
    expect(isUnsafeIntegerText('0x1298624375692894210')).toBe(false);
  });

  it('ignores surrounding whitespace, like the importers do', () => {
    expect(isUnsafeIntegerText(`  ${BIG}  `)).toBe(true);
  });
});

describe('quoteBigIntegers', () => {
  const parse = (json: string): unknown => JSON.parse(quoteBigIntegers(json));

  it('keeps every digit of a big id through JSON.parse', () => {
    expect(parse(`{"id":${BIG}}`)).toEqual({ id: BIG });
    // Without it the parse itself does the damage — no reviver can undo this.
    expect(JSON.parse(`{"id":${BIG}}`)).not.toEqual({ id: BIG });
  });

  it('leaves numbers a JS number holds exactly alone', () => {
    expect(parse('{"a":1,"b":-2,"c":9007199254740991}')).toEqual({
      a: 1,
      b: -2,
      c: 9007199254740991,
    });
  });

  it('leaves decimals and exponents alone', () => {
    expect(parse('{"a":1.5,"b":1e3,"c":-2.25E-2}')).toEqual({ a: 1.5, b: 1000, c: -0.0225 });
  });

  it('does not touch digits inside a string, or a key', () => {
    const src = `{"note":"id: ${BIG}","${BIG}":1}`;
    expect(quoteBigIntegers(src)).toBe(src);
  });

  it('honours escapes, so an escaped quote does not end the string', () => {
    const src = `{"note":"a \\" ${BIG}","id":${BIG}}`;
    expect(parse(src)).toEqual({ note: `a " ${BIG}`, id: BIG });
  });

  it('handles a big id in an array, and several in one document', () => {
    expect(parse(`[{"id":${BIG}},{"id":9007199254740993}]`)).toEqual([{ id: BIG }, { id: '9007199254740993' }]);
  });

  it('leaves a document with nothing to fix byte-identical', () => {
    const src = '{"a":[1,2,3],"b":"x","c":null,"d":true}';
    expect(quoteBigIntegers(src)).toBe(src);
  });

  it('survives a truncated document — the parse is what reports the error', () => {
    expect(() => quoteBigIntegers(`{"id":${BIG}`)).not.toThrow();
    expect(() => quoteBigIntegers('{"a":"unterminated')).not.toThrow();
  });
});

describe('a decimal is never rewritten, and never broken', () => {
  /** Rewrite, then insist the result is still JSON, and still the same value. */
  function roundTrip(json: string): unknown {
    const out = quoteBigIntegers(json);
    return JSON.parse(out) as unknown;
  }

  it('leaves a long decimal alone instead of quoting its fraction', () => {
    // The reported failure: a `capacity_mw` of 1.9040000000000001 came out as
    // `1."9040000000000001"` — the fraction digits were re-scanned as a number
    // literal of their own, found to exceed 2^53, and quoted. The file then would
    // not parse, so a workspace exported from this app could not be imported back.
    const json = '{"capacity_mw": 1.9040000000000001}';
    expect(quoteBigIntegers(json)).toBe(json);
    expect(roundTrip(json)).toEqual({ capacity_mw: 1.9040000000000001 });
  });

  it('survives every shape of JSON number', () => {
    const numbers = ['0', '-0', '1', '-1', '1.5', '-39.2145', '1.9040000000000001', '0.30000000000000004', '1e400', '1E5', '2.5e-3', '-2.5E+3', '1.0', '123456789.123456789'];
    for (const n of numbers) {
      const json = `{"v": ${n}}`;
      expect(quoteBigIntegers(json), n).toBe(json);
      expect(roundTrip(json), n).toEqual({ v: JSON.parse(n) as number });
    }
  });

  it('still quotes the unsafe INTEGERS beside them, in the same document', () => {
    const json = '{"id": 1298624375692894210, "lat": -39.2145, "n": 1.9040000000000001}';
    expect(roundTrip(json)).toEqual({ id: '1298624375692894210', lat: -39.2145, n: 1.9040000000000001 });
  });

  it('handles a decimal whose fraction alone would be an unsafe integer', () => {
    // The exact trap: 9040000000000001 > 2^53-1, so the old scan quoted it.
    for (const n of ['1.9040000000000001', '0.9007199254740993', '-8.999999999999999e2']) {
      expect(() => roundTrip(`[${n}]`), n).not.toThrow();
    }
  });

  it('leaves numbers inside strings alone, fraction and all', () => {
    const json = '{"note": "reads 1.9040000000000001 on the dial", "id": 9007199254740993}';
    expect(roundTrip(json)).toEqual({ note: 'reads 1.9040000000000001 on the dial', id: '9007199254740993' });
  });

  it('does not choke on a truncated number at the end of the text', () => {
    // Malformed input must come back as a parse error from JSON.parse, not as a
    // crash or an infinite loop inside the scanner.
    for (const bad of ['[1.', '[1e', '[1e+', '[-', '[1.2e']) {
      expect(() => quoteBigIntegers(bad), bad).not.toThrow();
      expect(() => JSON.parse(quoteBigIntegers(bad)), bad).toThrow();
    }
  });
});
