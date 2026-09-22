/**
 * One answer to "what type is this column?", for every importer.
 *
 * There used to be three ladders — `csv-import.inferType`, `json-import`'s
 * `inferTypeFromValues` and `datasette-client.inferColumnType` — with the same
 * shape, the same two shared helpers, and three different sets of date rules.
 * They disagreed on real data:
 *
 *   "2026-01-01T10:30"  CSV → datetime   JSON → date       Datasette → datetime
 *   "01/02/2026"        CSV → date       JSON → date       Datasette → string
 *   "2026-01-01"        CSV → date       JSON → date       Datasette → datetime
 *
 * json-import's copy even carried a comment saying its regexes "match
 * csv-import's" — the code itself documented that two places were being kept in
 * step by hand. This module is that step, done once.
 *
 * The one distinction worth keeping is {@link InferOptions.raw}: a text format
 * hands us the SPELLING of a value, a JSON-shaped one hands us the value. `0`
 * and `1` in a CSV cell are plausibly a boolean; the JSON numbers `0` and `1`
 * are numbers, and typing them boolean would lose the difference between a count
 * and a flag.
 */

import type { ColumnType } from '@easydb/shared';
import { looksLikeArrayColumn, looksLikeTextColumn } from '@easydb/shared';
import { isUnsafeIntegerText } from './big-numbers.js';

export interface InferOptions {
  /**
   * The values are unparsed text from a text format (CSV, and anything else
   * whose cells arrive as strings), so a value's spelling is all we have.
   *
   * Off for JSON, Datasette and anything else that arrives already typed: there
   * a string IS a string, and only the date branches read spellings.
   */
  raw?: boolean;
}

/** What `true`/`false` may be spelled as in a text format. */
const BOOL_TEXT_RE = /^(true|false|yes|no|0|1)$/i;

/**
 * A date with no time: ISO `YYYY-MM-DD`, or D/M/Y with `/`, `-` or `.`.
 *
 * A bare run of digits is refused, so a column of years or IDs does not become a
 * date. D/M/Y and M/D/Y are both accepted and are genuinely ambiguous here — the
 * coercion step is what picks one.
 */
export function isDateShape(value: string): boolean {
  const t = value.trim();
  if (t === '' || /^\d+$/.test(t)) return false;
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return true;
  return /^\d{1,2}[/\-.]\d{1,2}[/\-.]\d{2,4}$/.test(t);
}

/**
 * A date carrying a time, after a space or a `T`.
 *
 * Checked BEFORE {@link isDateShape} by the ladder, because every datetime would
 * otherwise have to be excluded from the date patterns by hand.
 *
 * Detection is by SHAPE, never by `new Date(s)`. V8's fallback parser is far
 * looser than it looks — `new Date('https://example.com/1')` is a valid date, it
 * plucks the `1` out — which once typed a column of URLs as a date and locked
 * out the link renderer.
 */
export function isDateTimeShape(value: string): boolean {
  const t = value.trim();
  if (t === '') return false;
  if (/^\d{4}-\d{2}-\d{2}[T ]\d{1,2}:\d{2}(:\d{2})?/.test(t)) return true;
  return /^\d{1,2}[/\-.]\d{1,2}[/\-.]\d{2,4}[T ]\d{1,2}:\d{2}/.test(t);
}

/** Is this value a boolean, or — in a text format — spelled like one? */
function isBoolean(value: unknown, raw: boolean): boolean {
  if (typeof value === 'boolean') return true;
  return raw && typeof value === 'string' && BOOL_TEXT_RE.test(value.trim());
}

/**
 * Is this value a number, or — in a text format — spelled like one?
 *
 * An integer past 2^53 cannot round-trip through a JS number, so a column
 * holding one is NOT a number column; it keeps its digits as text. The
 * JSON-shaped importers guard the same case earlier, at parse time
 * (`quoteBigIntegers`), because by the time `JSON.parse` has run the precision
 * is already gone.
 */
function isNumber(value: unknown, raw: boolean): boolean {
  if (typeof value === 'number') return Number.isFinite(value);
  if (!raw || typeof value !== 'string') return false;
  const t = value.trim();
  if (t === '' || isUnsafeIntegerText(t)) return false;
  return Number.isFinite(Number(t));
}

/** Only a string can carry a date SHAPE — a number that looks like one is a number. */
function isDateish(value: unknown, shaped: (s: string) => boolean): boolean {
  return typeof value === 'string' && shaped(value);
}

/**
 * The column type these values imply.
 *
 * Empty cells are dropped first: they say nothing about the type, and a column
 * that holds only empties is `string` rather than a guess. The order of the
 * ladder is load-bearing — `text` comes last because a cell long enough to be
 * text could not have been a number or a date anyway.
 */
export function inferColumnType(values: readonly unknown[], opts: InferOptions = {}): ColumnType {
  const raw = opts.raw ?? false;
  const samples = values.filter((v) => v !== null && v !== undefined && v !== '');
  if (samples.length === 0) return 'string';
  // A cell spelled `["a","b"]` is a list, whoever exported it. A cell with bare
  // commas is NOT — prose is full of commas, so a comma list only becomes an
  // `array` column when the header says so or the user picks the type.
  if (looksLikeArrayColumn(samples)) return 'array';
  if (samples.every((v) => isBoolean(v, raw))) return 'boolean';
  if (samples.every((v) => isNumber(v, raw))) return 'number';
  if (samples.every((v) => isDateish(v, isDateTimeShape))) return 'datetime';
  if (samples.every((v) => isDateish(v, isDateShape))) return 'date';
  if (looksLikeTextColumn(samples)) return 'text';
  return 'string';
}
