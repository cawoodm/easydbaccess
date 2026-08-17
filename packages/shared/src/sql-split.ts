/**
 * Splitting a SQL script into its individual statements.
 *
 * This exists because `SqlDriver.prepare` compiles ONE statement and silently
 * ignores whatever follows it. A console is the one place a user routinely
 * pastes several, so without this "run" on a three-statement script would run
 * the first and report success for all three.
 *
 * Pure, so it is tested without a database. It is a lexer, not a parser: it
 * knows only enough to tell a `;` that ends a statement from a `;` inside a
 * string, an identifier or a comment. That is the whole job.
 *
 * One thing it deliberately does NOT handle: `BEGIN ... END` blocks in a
 * trigger body, whose inner `;`s would each look like a statement end. Triggers
 * are not something this app's SQL surface creates, and guessing at block
 * structure would mean parsing SQL properly. A user who needs one can run it as
 * a single statement.
 */

/** One statement, plus where it started, so an error can point at the right line. */
export interface SqlStatementSlice {
  sql: string;
  /** Character offset of the statement's first character in the original text. */
  offset: number;
}

/** Quote characters that open a literal or a quoted identifier, and what closes them. */
const CLOSERS: Record<string, string> = { "'": "'", '"': '"', '`': '`', '[': ']' };

/**
 * Splits `script` on top-level semicolons.
 *
 * Empty statements — a stray `;`, a trailing one, a comment-only tail — are
 * dropped rather than returned, so a caller can run everything it gets back
 * without checking for blanks.
 */
export function splitStatements(script: string): SqlStatementSlice[] {
  const out: SqlStatementSlice[] = [];
  let start = 0;
  let i = 0;
  /**
   * Has anything executable appeared since the last `;`?
   *
   * Whitespace and comments do not count, so a trailing `-- done` is dropped
   * rather than handed back as a statement the caller would dutifully run and
   * report a result for.
   */
  let sawCode = false;

  const push = (end: number): void => {
    if (sawCode) {
      const slice = script.slice(start, end);
      // The offset points at the statement's own first character, not at the
      // whitespace the previous `;` left behind.
      out.push({ sql: slice.trim(), offset: start + (slice.length - slice.trimStart().length) });
    }
    start = end + 1;
    sawCode = false;
  };

  while (i < script.length) {
    const ch = script[i]!;
    const next = script[i + 1];

    // `--` to end of line.
    if (ch === '-' && next === '-') {
      const nl = script.indexOf('\n', i);
      i = nl === -1 ? script.length : nl + 1;
      continue;
    }
    // `/* */`, which SQLite does not nest.
    if (ch === '/' && next === '*') {
      const close = script.indexOf('*/', i + 2);
      i = close === -1 ? script.length : close + 2;
      continue;
    }
    const closer = CLOSERS[ch];
    if (closer !== undefined) {
      sawCode = true;
      i++;
      while (i < script.length) {
        if (script[i] === closer) {
          // A doubled quote is an escaped one, not the end — `'it''s'`. This is
          // also correct for `]`, where SQLite has no escape and the first `]`
          // simply closes.
          if (script[i + 1] === closer && closer !== ']') i += 2;
          else break;
        } else i++;
      }
      i++; // past the closing quote (or past the end of an unterminated one)
      continue;
    }
    if (ch === ';') {
      push(i);
      i++;
      continue;
    }
    if (!/\s/.test(ch)) sawCode = true;
    i++;
  }
  push(script.length);
  return out;
}
