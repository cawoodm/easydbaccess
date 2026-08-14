// Every sample the script editor offers is real code the user can save
// unchanged, so the suite treats them as code: each one must compile, must
// produce what it advertises, and — for a validator — must reject the value it
// exists to catch. A typo in a sample is otherwise only found by the person who
// picked it and got a "compile error" instead of a working script.

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Row } from '@easydb/shared';
import {
  RENDER_SAMPLES,
  VALIDATE_SAMPLES,
  VIZ_HTML_SAMPLES,
  VIZ_SCRIPT_SAMPLES,
  addUserSample,
  builtinSamples,
  parseUserSamples,
  removeUserSample,
  userSamplesFor,
} from '../../../packages/renderer/src/dialogs/script-samples.js';
import { runColumnScript, runValidateScript, runVizScript } from '../../../packages/renderer/src/util/column-script.js';
import { substituteVizTokens } from '../../../packages/renderer/src/viz/viz-tokens.js';
import { looksLikeCommandlet, parseCommandlets } from '../../../packages/renderer/src/plugins/commandlet-lang.js';

/** Run a validate sample by label — fails loudly if the label ever drifts. */
function run(label: string, value: unknown, row: Record<string, unknown> = {}) {
  const sample = VALIDATE_SAMPLES.find((s) => s.label === label);
  if (!sample) throw new Error(`no sample labelled "${label}"`);
  return runValidateScript(sample.source, value, row);
}

/** Run a render sample by label, returning its computed value. */
function render(label: string, row: Record<string, unknown>): unknown {
  const sample = RENDER_SAMPLES.find((s) => s.label === label);
  if (!sample) throw new Error(`no sample labelled "${label}"`);
  const out = runColumnScript(sample.source, row);
  if (!out.ok) throw new Error(`${label}: ${out.label} — ${out.message}`);
  return out.value;
}

const REQUIRED = 'Required — reject an empty cell';

describe('VALIDATE_SAMPLES', () => {
  it('offers exactly ten samples, each with a distinct label', () => {
    expect(VALIDATE_SAMPLES).toHaveLength(10);
    expect(new Set(VALIDATE_SAMPLES.map((s) => s.label)).size).toBe(10);
  });

  it('every sample compiles and defines validate(value, row)', () => {
    for (const s of VALIDATE_SAMPLES) {
      // A plausible value for each: what matters is that nothing throws a
      // SyntaxError or a ReferenceError, which surface as compile errors.
      const out = runValidateScript(s.source, '', {});
      if (!out.ok) expect(out.message, s.label).not.toMatch(/compile error/);
    }
  });

  it('leaves a blank cell alone — except the Required rule, which is the point of it', () => {
    for (const s of VALIDATE_SAMPLES) {
      const out = runValidateScript(s.source, '', {});
      expect(out.ok, s.label).toBe(s.label !== REQUIRED);
    }
  });
});

describe('each sample accepts and rejects what it says it does', () => {
  it('Required', () => {
    expect(run(REQUIRED, 'x').ok).toBe(true);
    expect(run(REQUIRED, '   ').ok).toBe(false);
    expect(run(REQUIRED, null).ok).toBe(false);
    expect(run(REQUIRED, undefined).ok).toBe(false);
  });

  it('Email address', () => {
    const L = 'Email address';
    expect(run(L, 'marc@monads.ch').ok).toBe(true);
    expect(run(L, 'marc@monads').ok).toBe(false);
    expect(run(L, 'not an email').ok).toBe(false);
    expect(run(L, 'a@b.c').ok).toBe(false); // single-letter TLD
  });

  it('Web address', () => {
    const L = 'Web address (http / https)';
    expect(run(L, 'https://monads.ch/x?y=1').ok).toBe(true);
    expect(run(L, 'http://localhost:5190').ok).toBe(true);
    expect(run(L, 'javascript:alert(1)').ok).toBe(false);
    expect(run(L, 'monads.ch').ok).toBe(false); // no scheme ⇒ not a URL
  });

  it('Whole number in a range', () => {
    const L = 'Whole number in a range';
    expect(run(L, 50).ok).toBe(true);
    expect(run(L, '1').ok).toBe(true); // the grid may hand over a string
    expect(run(L, 101).ok).toBe(false);
    expect(run(L, 0).ok).toBe(false);
    expect(run(L, 1.5).ok).toBe(false);
    expect(run(L, 'ten').ok).toBe(false);
  });

  it('Positive number', () => {
    const L = 'Positive number';
    expect(run(L, 0.01).ok).toBe(true);
    expect(run(L, 0).ok).toBe(false);
    expect(run(L, -3).ok).toBe(false);
    expect(run(L, 'abc').ok).toBe(false);
  });

  it('Text length between two limits', () => {
    const L = 'Text length between two limits';
    expect(run(L, 'abc').ok).toBe(true);
    expect(run(L, 'ab').ok).toBe(false);
    expect(run(L, 'x'.repeat(41)).ok).toBe(false);
    // Trimmed, so padding doesn't buy length.
    expect(run(L, '  a  ').ok).toBe(false);
  });

  it('One of a fixed list of values', () => {
    const L = 'One of a fixed list of values';
    expect(run(L, 'draft').ok).toBe(true);
    expect(run(L, 'Draft').ok).toBe(false); // case-sensitive by design
    expect(run(L, 'archived').ok).toBe(false);
  });

  it('Matches a pattern', () => {
    const L = 'Matches a pattern (regular expression)';
    expect(run(L, 'AB-1234').ok).toBe(true);
    expect(run(L, 'ab-1234').ok).toBe(false);
    expect(run(L, 'AB-123').ok).toBe(false);
  });

  it('A real date, not in the future', () => {
    const L = 'A real date, not in the future';
    expect(run(L, '2020-01-01').ok).toBe(true);
    expect(run(L, new Date().toISOString().slice(0, 10)).ok).toBe(true); // today
    expect(run(L, '2999-01-01').ok).toBe(false);
    expect(run(L, 'not a date').ok).toBe(false);
  });

  it('Depends on another column', () => {
    const L = 'Depends on another column (end after start)';
    expect(run(L, '2026-02-01', { start: '2026-01-01' }).ok).toBe(true);
    expect(run(L, '2026-01-01', { start: '2026-01-01' }).ok).toBe(true); // equal is fine
    expect(run(L, '2025-12-31', { start: '2026-01-01' }).ok).toBe(false);
    // Nothing to compare against yet — an unfinished row is not an error.
    expect(run(L, '2026-02-01', {}).ok).toBe(true);
  });
});

describe('the rejection message reaches the caller', () => {
  it('is the thrown message, verbatim — it is what the user is shown', () => {
    const out = run('One of a fixed list of values', 'archived');
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.message).toBe('"archived" is not allowed. Pick one of: draft, review, published.');
  });
});

describe('RENDER_SAMPLES', () => {
  it('offers exactly ten samples, each with a distinct label', () => {
    expect(RENDER_SAMPLES).toHaveLength(10);
    expect(new Set(RENDER_SAMPLES.map((s) => s.label)).size).toBe(10);
  });

  it('every sample compiles and defines render(row)', () => {
    for (const s of RENDER_SAMPLES) {
      const out = runColumnScript(s.source, {});
      expect(out.ok, `${s.label}: ${out.ok ? '' : `${out.label} — ${out.message}`}`).toBe(true);
    }
  });

  it('returns a blank string for an empty row rather than "undefined" or NaN', () => {
    // A script runs against every row, including the one the user just added
    // and hasn't filled in. Leaking "undefined undefined" or "NaN%" into the
    // grid is the most common way a naive script embarrasses itself.
    for (const s of RENDER_SAMPLES) {
      const out = runColumnScript(s.source, {});
      expect(out.ok).toBe(true);
      if (out.ok) expect(String(out.value), s.label).toBe('');
    }
  });
});

describe('each render sample computes what it says it does', () => {
  it('Join two fields', () => {
    expect(render('Join two fields into one', { first: 'Ada', last: 'Lovelace' })).toBe('Ada Lovelace');
    // A half-filled row gives the one field, not "Ada undefined".
    expect(render('Join two fields into one', { first: 'Ada' })).toBe('Ada');
  });

  it('Markdown → formatted text, via the markdownToHtml helper', () => {
    expect(render('Markdown → formatted text (markdownToHtml)', { notes: '**bold**' })).toBe('<p><strong>bold</strong></p>');
    // The helper sanitises rather than escapes: formatting in the data
    // survives, anything that could execute does not.
    expect(render('Markdown → formatted text (markdownToHtml)', { notes: 'a <b>bold</b> word' })).toContain('<b>bold</b>');
    expect(render('Markdown → formatted text (markdownToHtml)', { notes: '<script>x</script>' })).not.toContain('script');
  });

  it('Markdown summary takes the first line and bolds the title', () => {
    const out = render('Markdown summary — first line, bolded label', { title: 'Q3', notes: 'first line\nsecond line' });
    expect(out).toContain('<strong>Q3</strong>');
    expect(out).toContain('first line');
    expect(out).not.toContain('second line');
  });

  it('Build a URL from a field', () => {
    expect(render('Build a URL from a field', { repo: 'cawoodm' })).toBe('https://github.com/cawoodm');
    expect(render('Build a URL from a field', {})).toBe('');
  });

  it('Build a URL with query parameters — and encode them', () => {
    const out = String(render('Build a URL with query parameters', { street: 'Bahnhofstrasse 1', city: 'Zürich' }));
    expect(out.startsWith('https://www.openstreetmap.org/search?query=')).toBe(true);
    expect(out).toContain('Bahnhofstrasse+1');
    expect(out).not.toContain(' ');
  });

  it('Mailto link carries an encoded subject', () => {
    const out = String(render('Mailto link with a prefilled subject', { email: 'marc@monads.ch', title: 'Offer & terms' }));
    expect(out).toBe('mailto:marc@monads.ch?subject=Re%3A%20Offer%20%26%20terms');
  });

  it('Line total multiplies quantity by price', () => {
    expect(render('Maths — line total (quantity × price)', { qty: 3, price: 4.5 })).toBe('13.50');
    // Strings out of a text cell still multiply.
    expect(render('Maths — line total (quantity × price)', { qty: '2', price: '10' })).toBe('20.00');
    expect(render('Maths — line total (quantity × price)', { qty: 'x', price: 1 })).toBe('');
    // Half a line is not a total — blank beats a misleading 0.00.
    expect(render('Maths — line total (quantity × price)', { qty: 2 })).toBe('');
  });

  it('Money formatting uses the locale and currency in the sample', () => {
    const out = String(render('Maths — amount as money (Intl.NumberFormat)', { amount: 1234.5 }));
    expect(out).toContain('CHF');
    expect(out).toMatch(/1.234[.,]50/); // grouping/decimal glyphs are locale data
    expect(render('Maths — amount as money (Intl.NumberFormat)', { amount: 'n/a' })).toBe('');
  });

  it('Percentage rounds, and refuses to divide by zero', () => {
    expect(render('Maths — percentage of a total', { done: 3, total: 4 })).toBe('75%');
    expect(render('Maths — percentage of a total', { done: 1, total: 3 })).toBe('33%');
    expect(render('Maths — percentage of a total', { done: 5, total: 0 })).toBe('');
  });

  it('Days between a date and today reads in both directions', () => {
    const inDays = (n: number) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
    const L = 'Days between a date and today';
    expect(render(L, { due: inDays(3) })).toBe('in 3 days');
    expect(render(L, { due: inDays(-3) })).toBe('3 days ago');
    // Whole days, so a date-only value reads the same all day long.
    expect(render(L, { due: inDays(0) })).toBe('today');
    expect(render(L, { due: 'not a date' })).toBe('');
  });
});

// The user's own samples live in one workspace setting, so the list arrives from
// a store that may have been synced from another device or hand-edited in a
// dump. The reader is tolerant on purpose: a broken entry must cost the user
// that entry, never the script editor.
describe('user samples', () => {
  const sample = (over: Record<string, unknown> = {}) => ({ id: 'a', kind: 'render', label: 'Mine', source: 'function render(){return 1}', ...over });

  it('reads a stored list, and a JSON string of one', () => {
    expect(parseUserSamples([sample()])).toEqual([{ id: 'a', kind: 'render', label: 'Mine', source: 'function render(){return 1}' }]);
    expect(parseUserSamples(JSON.stringify([sample()]))).toHaveLength(1);
  });

  it('drops entries with no id, no label or no source, and keeps the rest', () => {
    const list = parseUserSamples([sample({ id: '' }), sample({ id: 'b', label: '  ' }), sample({ id: 'c', source: '' }), sample({ id: 'd' })]);
    expect(list.map((s) => s.id)).toEqual(['d']);
  });

  it('survives anything that is not a list', () => {
    for (const junk of [null, undefined, 42, 'nonsense', {}, ['x']]) expect(parseUserSamples(junk)).toEqual([]);
  });

  it('defaults an unknown kind to render — a sample of no known shape is a render sample', () => {
    expect(parseUserSamples([sample({ kind: 'wat' })])[0]?.kind).toBe('render');
    expect(parseUserSamples([sample({ kind: 'validate' })])[0]?.kind).toBe('validate');
  });

  it('splits the two kinds, so a validator is never offered as a renderer', () => {
    const all = parseUserSamples([sample({ id: 'r' }), sample({ id: 'v', kind: 'validate' })]);
    expect(userSamplesFor(all, 'render').map((s) => s.id)).toEqual(['r']);
    expect(userSamplesFor(all, 'validate').map((s) => s.id)).toEqual(['v']);
  });

  it('adds and removes by id, leaving the others alone', () => {
    const one = addUserSample([], { id: 'x', kind: 'render', label: 'X', source: 'x' });
    const two = addUserSample(one, { id: 'y', kind: 'validate', label: 'Y', source: 'y' });
    expect(two.map((s) => s.id)).toEqual(['x', 'y']);
    expect(removeUserSample(two, 'x').map((s) => s.id)).toEqual(['y']);
    // Removing something that isn't there is not an error, just a no-op.
    expect(removeUserSample(two, 'nope')).toHaveLength(2);
  });

  it('builtinSamples answers per kind, and a token script shares the render list', () => {
    expect(builtinSamples('render')).toBe(RENDER_SAMPLES);
    expect(builtinSamples('validate')).toBe(VALIDATE_SAMPLES);
    // A visualization's markup and its code keep separate lists: a sample is
    // pasted whole, and HTML landing in the script box is not recoverable.
    expect(builtinSamples('viz-html')).toBe(VIZ_HTML_SAMPLES);
    expect(builtinSamples('viz-script')).toBe(VIZ_SCRIPT_SAMPLES);
  });

  it('keeps a saved viz sample in its own list, and an unknown kind reads as render', () => {
    const stored = [
      { id: 'a', kind: 'viz-html', label: 'My header', source: '<b>$COUNT</b>' },
      { id: 'b', kind: 'wat', label: 'Older build', source: 'function render(row) { return 1; }' },
    ];
    const parsed = parseUserSamples(stored);
    expect(userSamplesFor(parsed, 'viz-html').map((s) => s.id)).toEqual(['a']);
    expect(userSamplesFor(parsed, 'render').map((s) => s.id)).toEqual(['b']);
  });
});

// The custom-visualization samples ARE the documentation for that feature — the
// dropdown is how it is discovered — so they are held to the same bar: every one
// draws something the first time it is picked, over rows that look like a real
// table rather than a fixture built to flatter them.

const VIZ_ROWS: Row[] = [
  { id: 'r1', tableId: 't', data: { country: 'CH', amount: 10 }, updatedAt: 0 },
  { id: 'r2', tableId: 't', data: { country: 'DE', amount: 5 }, updatedAt: 0 },
  { id: 'r3', tableId: 't', data: { country: 'CH', amount: 20 }, updatedAt: 0 },
];

describe('VIZ_HTML_SAMPLES', () => {
  it('offers six samples, each with a distinct label', () => {
    expect(VIZ_HTML_SAMPLES).toHaveLength(6);
    expect(new Set(VIZ_HTML_SAMPLES.map((s) => s.label)).size).toBe(6);
  });

  it('every sample draws something over the sample columns it names', () => {
    for (const s of VIZ_HTML_SAMPLES) {
      const out = substituteVizTokens(s.source, VIZ_ROWS);
      expect(out.length, s.label).toBeGreaterThan(0);
      // A token naming a column that is not there renders an error chip, so this
      // catches a sample whose field names drifted from the ones it documents.
      expect(out, s.label).not.toContain('eda-token-error');
      expect(out, s.label).not.toMatch(/\$(COUNT|SUM|AVG|MIN|MAX|DISTINCT|filter)\b/);
    }
  });

  it('the pill sample really emits pills, and the KPI samples real numbers', () => {
    const pills = VIZ_HTML_SAMPLES.find((s) => s.label.startsWith('Filter pills'));
    expect(substituteVizTokens(pills!.source, VIZ_ROWS)).toContain('data-eda-filter-value="CH"');
    const tile = VIZ_HTML_SAMPLES.find((s) => s.label.startsWith('KPI tile'));
    expect(substituteVizTokens(tile!.source, VIZ_ROWS)).toContain('>3<');
  });
});

describe('the #links in the HTML samples are real commandlets', () => {
  /** Every `href="#…"` across the samples, as the DOM would hand it back. */
  function links(): string[] {
    const out: string[] = [];
    for (const s of VIZ_HTML_SAMPLES) {
      for (const m of s.source.matchAll(/href="#([^"]+)"/g)) out.push((m[1] ?? '').replace(/&amp;/g, '&'));
    }
    return out;
  }

  it('there are some, and every one parses', () => {
    // A sample link that does not parse is a dead end the user only finds by
    // clicking it and getting an error toast.
    const all = links();
    expect(all.length).toBeGreaterThan(0);
    for (const href of all) {
      expect(looksLikeCommandlet(href), href).toBe(true);
      expect(() => parseCommandlets(href), href).not.toThrow();
    }
  });

  it('none of them names a table, so the block works wherever it is dropped', () => {
    for (const href of links()) {
      const [cmd] = parseCommandlets(href);
      expect(cmd?.verb, href).toBe('goto');
      expect(cmd?.targets, href).toEqual([]);
    }
  });

  it('the toolbar sample covers filtering, sorting and searching', () => {
    const toolbar = VIZ_HTML_SAMPLES.find((s) => s.label.startsWith('Toolbar'));
    const parsed = [...(toolbar?.source ?? '').matchAll(/href="#([^"]+)"/g)].map((m) => parseCommandlets((m[1] ?? '').replace(/&amp;/g, '&'))[0]);
    expect(parsed.some((c) => Object.keys(c?.filters ?? {}).length > 0)).toBe(true);
    expect(parsed.some((c) => c?.options.sort !== undefined)).toBe(true);
    expect(parsed.some((c) => c?.options.search !== undefined)).toBe(true);
    expect(parsed.some((c) => c?.options.clear !== undefined)).toBe(true);
  });
});

describe('VIZ_SCRIPT_SAMPLES', () => {
  it('offers two samples — one per half of the contract', () => {
    expect(VIZ_SCRIPT_SAMPLES).toHaveLength(2);
    expect(new Set(VIZ_SCRIPT_SAMPLES.map((s) => s.label)).size).toBe(2);
  });

  it('every sample compiles and defines render(rows, api)', () => {
    for (const s of VIZ_SCRIPT_SAMPLES) {
      const out = runVizScript(s.source, VIZ_ROWS, fakeVizApi());
      expect(out.ok, `${s.label}: ${out.ok ? '' : `${out.label} — ${out.message}`}`).toBe(true);
    }
  });

  it('survives an empty set rather than throwing on the first row', () => {
    for (const s of VIZ_SCRIPT_SAMPLES) {
      const out = runVizScript(s.source, [], fakeVizApi());
      expect(out.ok, s.label).toBe(true);
    }
  });

  it('one returns a string and the other writes into api.el', () => {
    const returning = VIZ_SCRIPT_SAMPLES.find((s) => s.label.startsWith('Return a string'));
    const out = runVizScript(returning!.source, VIZ_ROWS, fakeVizApi());
    expect(out.ok && typeof out.value === 'string').toBe(true);

    const writing = VIZ_SCRIPT_SAMPLES.find((s) => s.label.startsWith('Write into api.el'));
    const api = fakeVizApi();
    const wrote = runVizScript(writing!.source, VIZ_ROWS, api);
    expect(wrote.ok && wrote.value === undefined).toBe(true);
    expect(api.appended).toBe(2); // one button per distinct country
  });

  it('the api.el sample asks the host to filter when a button is clicked', () => {
    const writing = VIZ_SCRIPT_SAMPLES.find((s) => s.label.startsWith('Write into api.el'));
    const api = fakeVizApi();
    runVizScript(writing!.source, VIZ_ROWS, api);
    api.clickFirst();
    expect(api.filtered).toEqual([['country', 'CH']]);
  });
});

/**
 * Just enough `document` for the api.el sample to run.
 *
 * This suite has no DOM (see docs/tech/TESTING.md), and a sample that builds
 * real elements is the whole point of the second script sample — checking only
 * that it COMPILES would leave the interesting half, the click that asks the
 * host to filter, untested. Twenty lines of stub buy that assertion.
 */
interface FakeEl {
  tagName: string;
  type: string;
  textContent: string;
  style: { cssText: string };
  children: FakeEl[];
  listeners: Array<() => void>;
  addEventListener(ev: string, fn: () => void): void;
  append(...kids: FakeEl[]): void;
  replaceChildren(...kids: FakeEl[]): void;
}

function fakeEl(tagName = 'div'): FakeEl {
  const el: FakeEl = {
    tagName,
    type: '',
    textContent: '',
    style: { cssText: '' },
    children: [],
    listeners: [],
    addEventListener(_ev, fn) {
      el.listeners.push(fn);
    },
    append(...kids) {
      el.children.push(...kids);
    },
    replaceChildren(...kids) {
      el.children = [...kids];
    },
  };
  return el;
}

beforeAll(() => vi.stubGlobal('document', { createElement: (tag: string) => fakeEl(tag) }));
afterAll(() => vi.unstubAllGlobals());

/** The `api` a visualization script is handed, recording what it was asked for. */
function fakeVizApi() {
  const el = fakeEl();
  const filtered: Array<[string, string]> = [];
  return {
    el,
    columns: [],
    filter: (field: string, value: string) => void filtered.push([field, value]),
    sort: () => {},
    filtered,
    get appended() {
      return el.children.length;
    },
    clickFirst() {
      el.children[0]?.listeners[0]?.();
    },
  };
}
