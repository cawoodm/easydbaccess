/**
 * Integers too big for a JavaScript number, on the way in.
 *
 * A JS number is a float64: every integer up to 2^53-1 is exact, and past that
 * the digits are approximated. A snowflake id like `1298624375692894210` reads
 * back as `1298624375692894200` — the value is silently WRONG, and nothing
 * downstream can tell, because there is no error and the shape still looks like
 * a number. An id is not arithmetic anyway; it is a name written in digits.
 *
 * So an importer keeps such a value as TEXT. All the digits survive, the column
 * types as `string`, and the value can still be searched, filtered, sorted and
 * sent back to the source unchanged.
 */

/** A decimal integer literal, optionally signed. No exponent, no fraction. */
const INTEGER_TEXT = /^[+-]?\d+$/;

const isDigit = (c: string | undefined): boolean => c !== undefined && c >= '0' && c <= '9';

/**
 * True when `s` is an integer literal that a JS number cannot hold exactly.
 *
 * Only integers are judged. A decimal (`0.1`, `1e400`) loses precision by its
 * nature and a column of measurements is still a number column — it is the
 * whole-number identifiers, where every digit is meaningful, that must not be
 * rounded.
 */
export function isUnsafeIntegerText(s: string): boolean {
  const t = s.trim();
  if (!INTEGER_TEXT.test(t)) return false;
  return !Number.isSafeInteger(Number(t));
}

/**
 * Rewrite every unsafe integer LITERAL in a JSON document as a quoted string,
 * so `JSON.parse` cannot round it.
 *
 * This has to happen before the parse, not after: `JSON.parse` produces the
 * damaged number itself, and no reviver can recover the digits it dropped (a
 * reviver is handed the already-parsed value). There is no option to ask for
 * bigints either, so the only place left to intervene is the text.
 *
 * The scan skips string contents, so a value like `"id: 1298624375692894210"`
 * and a key of that name are untouched — only bare literals in value position
 * are quoted. Escapes inside strings are honoured, so a `\\"` does not end one.
 *
 * Every number literal is consumed WHOLE — fraction and exponent included — even
 * though only a plain integer can ever be rewritten. Leaving the fraction for the
 * next turn of the loop is what made `1.9040000000000001` come back as invalid
 * JSON; see the comment at the number branch.
 */
export function quoteBigIntegers(json: string): string {
  let out = '';
  let i = 0;
  let inString = false;
  while (i < json.length) {
    const ch = json[i]!;
    if (inString) {
      out += ch;
      if (ch === '\\') {
        // Copy the escaped character with it, so `\"` cannot close the string.
        i++;
        if (i < json.length) out += json[i]!;
      } else if (ch === '"') {
        inString = false;
      }
      i++;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      i++;
      continue;
    }
    // Outside a string, a `-` or a digit can only begin a number literal.
    if (ch === '-' || (ch >= '0' && ch <= '9')) {
      let j = i;
      if (json[j] === '-') j++;
      while (j < json.length && isDigit(json[j])) j++;
      const digitsEnd = j;
      // Consume the FRACTION and the EXPONENT too, even though neither can be an
      // unsafe integer. Stopping at the integer part and letting the loop pick the
      // rest up is what corrupted a long decimal: `1.9040000000000001` came out as
      // `1."9040000000000001"` — the `.` copied as an ordinary character, then the
      // 16 fraction digits re-scanned as a number literal of their own, found to
      // exceed 2^53, and quoted. The result would not parse at all, which is how
      // an exported file could fail to import ("Unterminated fractional number").
      if (json[j] === '.') {
        j++;
        while (j < json.length && isDigit(json[j])) j++;
      }
      if (json[j] === 'e' || json[j] === 'E') {
        j++;
        if (json[j] === '+' || json[j] === '-') j++;
        while (j < json.length && isDigit(json[j])) j++;
      }
      const literal = json.slice(i, j);
      // Only a whole number is a candidate: `j === digitsEnd` means nothing
      // followed the digits, so this is an integer literal and not a decimal.
      out += j === digitsEnd && isUnsafeIntegerText(literal) ? `"${literal}"` : literal;
      i = j;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}
