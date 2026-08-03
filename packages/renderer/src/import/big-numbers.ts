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
    // A number literal starts here only if the previous non-space character was
    // structural — otherwise these digits belong to something else entirely.
    if (ch === '-' || (ch >= '0' && ch <= '9')) {
      let j = i;
      if (json[j] === '-') j++;
      while (j < json.length && json[j]! >= '0' && json[j]! <= '9') j++;
      const digitsEnd = j;
      // A fraction or an exponent means it is not an integer literal; leave it.
      const next = json[j];
      const isInteger = next !== '.' && next !== 'e' && next !== 'E';
      const literal = json.slice(i, digitsEnd);
      if (isInteger && isUnsafeIntegerText(literal)) {
        out += `"${literal}"`;
      } else {
        out += literal;
      }
      i = digitsEnd;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}
