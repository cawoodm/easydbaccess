// packages/renderer/src/plugins/commandlet-lang.ts
//
// The commandlet grammar. A commandlet is one URL-shaped string that names an
// action, its targets and its parameters:
//
//   goto/bible?Book=Matthew
//   goto/bible?Book=^M&Chapter==5&@sort=-Chapter
//   goto/notes?@search=berlin&@sort=-Date
//   view/Reading plan
//   cmd/windows:close-all
//   goto/bible?Book=Matthew;preview/bible/Text?Chapter==5
//
// Path = the verb and its positional targets. Query = everything named: a key is
// a COLUMN FILTER unless it starts with `@`, which marks a reserved option. The
// `@` (rather than Datasette's leading `_`) is deliberate — this app meets
// `_id`-style columns routinely and they must stay filterable.
//
// A filter's value is handed to `column-filter.ts` untouched, so `^`, `!`, `,`,
// `NULL` and `AND` keep their usual meaning. `Chapter==5` is one key and one
// value (`=5`, the exact-match prefix), not a new operator.
//
// Pure and DOM-free: this module only turns text into structure. Everything that
// touches the store, a window or the registry lives in `commandlet-run.ts`.

/** Verbs the language knows. `table` is an alias of `goto`. */
export type CommandletVerb = 'goto' | 'search' | 'preview' | 'view' | 'cmd' | 'ui';

const VERB_ALIASES: Record<string, CommandletVerb> = {
  goto: 'goto',
  table: 'goto',
  search: 'search',
  preview: 'preview',
  view: 'view',
  cmd: 'cmd',
  ui: 'ui',
};

/** How many targets each verb takes. `rest` ⇒ the remaining segments, joined. */
const ARITY: Record<CommandletVerb, { min: number; rest: boolean }> = {
  goto: { min: 1, rest: false },
  search: { min: 1, rest: true },
  preview: { min: 2, rest: false },
  view: { min: 1, rest: true },
  cmd: { min: 1, rest: true },
  ui: { min: 1, rest: false },
};

export interface Commandlet {
  verb: CommandletVerb;
  /** Decoded path segments after the verb. */
  targets: string[];
  /** Query keys without `@` — field → column-filter expression. */
  filters: Record<string, string>;
  /** Query keys with `@`, stored without it and lower-cased. */
  options: Record<string, string>;
  /** The text this was parsed from, for error messages. */
  raw: string;
}

/** A commandlet that does not parse. The message is shown to the user as-is. */
export class CommandletError extends Error {}

/**
 * True when `input` starts with a known verb — the test for "is this hash a
 * commandlet, or just an anchor?". A bare `#Matthew` is deliberately NOT one:
 * that is input for the user's own hash rules, not an action.
 */
export function looksLikeCommandlet(input: string): boolean {
  const first = input.trim().split(/[/?;]/, 1)[0] ?? '';
  return first.toLowerCase() in VERB_ALIASES;
}

/** Parse a `;`-separated string into commandlets. Throws `CommandletError`. */
export function parseCommandlets(input: string): Commandlet[] {
  const parts = input
    .split(';')
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length === 0) throw new CommandletError('Empty commandlet.');
  return parts.map(parseOne);
}

function parseOne(raw: string): Commandlet {
  const cut = raw.indexOf('?');
  const pathText = cut < 0 ? raw : raw.slice(0, cut);
  const queryText = cut < 0 ? '' : raw.slice(cut + 1);

  const segments = pathText
    .split('/')
    .filter((s) => s !== '')
    .map((s) => decodeSegment(s, raw));
  if (segments.length === 0) throw new CommandletError(`No action in "${raw}".`);

  // An unknown first segment is a table name, so `bible?Book=Matthew` works.
  // A table actually called `search` needs the explicit `goto/` form.
  const head = (segments[0] ?? '').toLowerCase();
  const known = VERB_ALIASES[head];
  const verb: CommandletVerb = known ?? 'goto';
  let targets = known ? segments.slice(1) : segments;

  const arity = ARITY[verb];
  if (targets.length < arity.min) {
    throw new CommandletError(`"${verb}" needs ${arity.min} target${arity.min === 1 ? '' : 's'} — got "${raw}".`);
  }
  // A greedy verb owns the rest of the path: a command id contains `:` and may
  // contain `/`, and a search phrase is free text.
  if (arity.rest && targets.length > arity.min) {
    targets = [...targets.slice(0, arity.min - 1), targets.slice(arity.min - 1).join('/')];
  }

  const filters: Record<string, string> = {};
  const options: Record<string, string> = {};
  for (const [key, value] of new URLSearchParams(queryText)) {
    if (key.startsWith('@')) options[key.slice(1).toLowerCase()] = value;
    else if (key !== '') filters[key] = value;
  }

  return { verb, targets, filters, options, raw };
}

function decodeSegment(s: string, raw: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    throw new CommandletError(`Bad percent-encoding in "${raw}".`);
  }
}

/**
 * Replace `$NAME` placeholders with values, AFTER parsing.
 *
 * The order matters and is the whole point: substituting into the text first
 * would let a value containing `&` or `;` split a parameter or the chain. Here a
 * substituted value can only ever land inside one field, whatever it contains.
 *
 * Unknown placeholders are left alone, so a `$1` with no capture stays visible
 * instead of silently becoming empty.
 */
export function substituteCommandlet(cmd: Commandlet, vars: Record<string, string>): Commandlet {
  // `\d+` is its own alternative because the numbered captures (`$1`…`$9`, the
  // parts of a `/`-separated anchor) do not start with a letter.
  const swap = (s: string): string => s.replace(/\$([A-Za-z_][A-Za-z0-9_]*|\d+)/g, (whole, name: string) => vars[name] ?? whole);
  const mapValues = (o: Record<string, string>): Record<string, string> => Object.fromEntries(Object.entries(o).map(([k, v]) => [swap(k), swap(v)]));
  return {
    verb: cmd.verb,
    targets: cmd.targets.map(swap),
    filters: mapValues(cmd.filters),
    options: mapValues(cmd.options),
    raw: cmd.raw,
  };
}

/**
 * Build a commandlet string with everything encoded — the counterpart of the
 * parser, used by `easydb.cmdlet()` in a column script so a link carrying a
 * value like `Smith & Co` cannot break its own query.
 */
export function formatCommandlet(path: string | string[], params?: Record<string, string | number | boolean>): string {
  const segments = Array.isArray(path) ? path : path.split('/').filter(Boolean);
  const encodedPath = segments.map((s) => encodeURIComponent(s)).join('/');
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params ?? {})) qs.append(key, String(value));
  const query = qs.toString();
  return `#${encodedPath}${query ? `?${query}` : ''}`;
}
