/**
 * An `array` column holds SEVERAL values in one cell. Four spellings arrive
 * from the wild and all four have to read the same way:
 *
 *   foo,bar,baz       a comma-separated list, as a CSV writes it
 *   ["Foo", "Bar"]    a JSON array as TEXT, as an API or a Datasette column writes it
 *   ['Foo', 'Bar']    the same thing single-quoted, as Python's repr writes it
 *   [Foo, Bar]        a real JS array, as `json-import` stores it
 *
 * Everything that would otherwise treat the cell as one string — the funnel
 * dropdown, the per-column matcher, the view's filter chips — asks this module
 * for the MEMBERS instead. That is the whole point of the type: the dropdown for
 * `foo,bar,baz` offers three values rather than one, and filtering for `bar`
 * keeps the row instead of demanding the entire cell.
 *
 * Nothing here rewrites a stored cell. The value stays exactly as it was
 * imported, in whichever of the three spellings it came in — the type only
 * changes how it is READ.
 */

/** Cheap shape test: could this text be a JSON array? */
export function looksLikeJsonArray(text: string): boolean {
  const t = text.trim();
  return t.length >= 2 && t.startsWith('[') && t.endsWith(']');
}

/**
 * The parsed members of a JSON-array TEXT value, or `null` when the text is not
 * one. `null` also covers valid JSON that is not an array (`"3"`, `{}`), so a
 * caller can tell "not an array" from "an empty array".
 */
export function jsonArray(text: string): unknown[] | null {
  if (!looksLikeJsonArray(text)) return null;
  try {
    const parsed: unknown = JSON.parse(text.trim());
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    // Text that merely looks like an array — `[unquoted, words]`, a truncated
    // export — falls back to the comma split, which handles it fine.
    return null;
  }
}

/**
 * `['a', 'b']` — a bracketed list whose members are SINGLE-quoted. Not JSON, so
 * `JSON.parse` refuses it, but it is what Python's `repr` writes and therefore
 * what a great many exported CSVs hold. Returns the members, or `null` when the
 * text is not exactly that shape.
 *
 * Deliberately strict: every member must be a complete single-quoted run, so
 * `[unquoted, words]` and a half-and-half `["a", 'b']` both answer `null` and
 * fall through to the comma split exactly as before. Being loose here would
 * start reinterpreting ordinary prose that happens to sit in brackets.
 */
export function singleQuotedArray(text: string): string[] | null {
  const t = text.trim();
  if (!looksLikeJsonArray(t)) return null;
  const inner = t.slice(1, -1).trim();
  if (inner === '') return null; // `[]` is JSON's job, and it means "no members"
  const out: string[] = [];
  let i = 0;
  while (i < inner.length) {
    while (i < inner.length && /\s/.test(inner[i]!)) i++;
    if (inner[i] !== "'") return null;
    i++; // opening quote
    let member = '';
    let closed = false;
    while (i < inner.length) {
      const ch = inner[i]!;
      // `\'` is how a member carrying an apostrophe arrives, so it is a literal
      // quote rather than the end of the member.
      if (ch === '\\' && inner[i + 1] === "'") {
        member += "'";
        i += 2;
        continue;
      }
      if (ch === "'") {
        closed = true;
        i++;
        break;
      }
      member += ch;
      i++;
    }
    if (!closed) return null;
    out.push(member);
    while (i < inner.length && /\s/.test(inner[i]!)) i++;
    if (i < inner.length) {
      if (inner[i] !== ',') return null;
      i++;
    }
  }
  return out;
}

/** The members of a list LITERAL — JSON first, then the single-quoted spelling. */
function listLiteral(text: string): unknown[] | null {
  return jsonArray(text) ?? singleQuotedArray(text);
}

/**
 * The members of an array cell. Empty members are dropped, so `a,,b` is two
 * values and a blank cell is none at all — an "empty" array cell therefore
 * answers `[]` whichever spelling it used (`''`, `'[]'`, `[]`).
 *
 * A member of a comma list keeps its inner comma when quoted (`"Berlin, DE",Zurich`
 * is two members), matching the quoting rule the column-filter language already
 * uses for the same problem.
 */
export function arrayMembers(value: unknown): string[] {
  if (value == null) return [];
  if (Array.isArray(value)) return membersOf(value);
  if (typeof value !== 'string') return membersOf([value]);
  const parsed = listLiteral(value);
  return parsed ? membersOf(parsed) : splitList(value);
}

/** How an array cell reads as one line — for a tooltip, a sort key, an export. */
export function arrayCellText(value: unknown): string {
  return arrayMembers(value).join(', ');
}

/**
 * Is this value an array as far as type inference is concerned? A real array or
 * a list LITERAL as text, and deliberately NOT a comma-separated string: ordinary
 * prose is full of commas, so guessing `array` from one would retype half the
 * text columns in a CSV. Comma lists are still READ as members — a user (or a
 * `field:label:array` header) says so by picking the type.
 */
export function looksLikeArray(value: unknown): boolean {
  if (Array.isArray(value)) return true;
  return typeof value === 'string' && listLiteral(value) !== null;
}

/**
 * How many non-empty cells in a row have to be lists before a column is one.
 *
 * `every` was too strict for real data: one `n/a`, one hand-typed note, one
 * header row read as data, and a column of thousands of lists stayed `string` —
 * so the tags renderer never appeared and the funnel offered whole cells instead
 * of members. A RUN is the evidence, because a run cannot be produced by
 * coincidence the way a single bracketed cell can.
 */
export const ARRAY_RUN = 5;

/**
 * Is this column a list column? True when {@link ARRAY_RUN} non-empty cells IN A
 * ROW are all lists, or — for a column with fewer values than that — when every
 * one of them is. The short-column case keeps the old behaviour, so a two-row
 * import of `["a","b"]` is still typed `array`.
 *
 * `values` must already have the empty cells dropped: "consecutive" means
 * consecutive among the cells that hold something, since a gap says nothing
 * either way.
 */
export function looksLikeArrayColumn(values: readonly unknown[]): boolean {
  if (values.length === 0) return false;
  let run = 0;
  for (const v of values) {
    if (looksLikeArray(v)) {
      run++;
      if (run >= ARRAY_RUN) return true;
    } else {
      run = 0;
    }
  }
  return values.length < ARRAY_RUN && run === values.length;
}

/** Stringify one member of a list; `null`/`undefined` and blanks are dropped. */
function membersOf(list: readonly unknown[]): string[] {
  const out: string[] = [];
  for (const v of list) {
    if (v == null) continue;
    const s = typeof v === 'string' ? v.trim() : typeof v === 'object' ? (JSON.stringify(v) ?? '') : String(v);
    if (s !== '') out.push(s);
  }
  return out;
}

/**
 * Split a comma list, honouring double quotes: a quoted run protects its commas
 * and its whitespace, and `""` inside one is a literal quote. Unquoted members
 * are trimmed. Same rules as `parseColumnFilter`, so a value that survives one
 * survives the other.
 */
function splitList(text: string): string[] {
  const out: string[] = [];
  let buf = '';
  let quoted = false;
  let hadQuote = false;
  const flush = () => {
    const member = hadQuote ? buf : buf.trim();
    if (member !== '') out.push(member);
    buf = '';
    quoted = false;
    hadQuote = false;
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === '"') {
      if (quoted && text[i + 1] === '"') {
        buf += '"';
        i++;
        continue;
      }
      quoted = !quoted;
      hadQuote = true;
      continue;
    }
    if (ch === ',' && !quoted) {
      flush();
      continue;
    }
    buf += ch;
  }
  flush();
  return out;
}
