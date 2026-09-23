// packages/renderer/src/plugins/date-presets.ts
//
// The `date-filter:presets` setting, read. `3m,6m,1y,y` becomes four labelled
// rows, each carrying the relative term its filter uses.
//
// Pure and DOM-free so the labelling rules are testable without a popover. The
// terms it produces are `relative-date.ts`'s, so a preset is always a live
// window rather than a snapshot — see the design note on why.

/** One row of the preset list. */
export interface DatePreset {
  /** The spec entry it came from, so the UI can round-trip it. */
  entry: string;
  label: string;
  /** The relative term, e.g. `-3m` or `ytd`. */
  term: string;
}

export const DEFAULT_DATE_PRESETS = '3m,6m,1y,y';

const UNITS: Record<string, { one: string; many: string }> = {
  d: { one: 'day', many: 'days' },
  w: { one: 'week', many: 'weeks' },
  m: { one: 'month', many: 'months' },
  y: { one: 'year', many: 'years' },
};

const TO_DATE: Record<string, { term: string; label: string }> = {
  y: { term: 'ytd', label: 'Year to date' },
  q: { term: 'qtd', label: 'Quarter to date' },
  m: { term: 'mtd', label: 'Month to date' },
  w: { term: 'wtd', label: 'Week to date' },
};

const OFFSET = /^(\d+)([dwmy])$/;

/**
 * The preset list a spec string asks for.
 *
 * An entry that cannot be read is SKIPPED rather than shown as a broken row: a
 * typo in a setting should cost one preset, not the whole dropdown.
 */
export function parseDatePresets(spec: string): DatePreset[] {
  const out: DatePreset[] = [];
  const seen = new Set<string>();
  for (const raw of String(spec ?? '').split(',')) {
    const entry = raw.trim();
    if (entry === '') continue;
    const eq = entry.indexOf('=');
    const code = (eq >= 0 ? entry.slice(0, eq) : entry).trim().toLowerCase();
    const custom = eq >= 0 ? entry.slice(eq + 1).trim() : '';
    const read = readCode(code);
    if (!read) continue;
    if (seen.has(code)) continue;
    seen.add(code);
    out.push({ entry, label: custom || read.label, term: read.term });
  }
  return out;
}

/** One entry's code — `3m`, `1y`, `y` — as a term and a default label. */
function readCode(code: string): { term: string; label: string } | null {
  const toDate = TO_DATE[code];
  if (toDate) return { term: toDate.term, label: toDate.label };
  const m = OFFSET.exec(code);
  if (!m) return null;
  const n = Number(m[1]);
  const suffix = m[2]!;
  const unit = UNITS[suffix];
  if (!unit || n < 1) return null;
  // "Last year" would read as the previous CALENDAR year, which is not what a
  // rolling twelve-month window is. Every other unit is unambiguous at one.
  if (code === '1y') return { term: '-1y', label: 'Past year' };
  const label = n === 1 ? `Last ${unit.one}` : `Last ${n} ${unit.many}`;
  return { term: `-${n}${suffix}`, label };
}
