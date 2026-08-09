import { describe, it, expect } from 'vitest';
import type { ColumnSpec, Row } from '@easydb/shared';
import {
  extractTokens,
  extractFilterTokens,
  evaluateRow,
  evaluateRows,
  substituteRow,
  tokenValue,
  filterRows,
  sortRows,
  viewRows,
  hasRowHtml,
  addPillValue,
  cyclePillValue,
  pillValueState,
  removePillValue,
} from '../../../packages/renderer/src/views/view-render.js';

const row = (data: Record<string, unknown>): Row => ({ id: 'r', tableId: 't', data, updatedAt: 0 });
const col = (field: string, type: ColumnSpec['type'], label?: string): ColumnSpec => ({
  field,
  label: label ?? field,
  type,
});

describe('view-render', () => {
  it('extracts distinct tokens across fragments', () => {
    expect(extractTokens('<a href="$URL">$TITLE</a>', '', 'foot $DATE $TITLE').sort()).toEqual(['DATE', 'TITLE', 'URL']);
  });

  it('ignores a $ not followed by a word (e.g. prices)', () => {
    expect(extractTokens('costs $5.00 today')).toEqual([]);
  });

  it('substitutes mapped tokens and blanks unmapped/null ones', () => {
    const html = '<a href="$URL">$TITLE</a>$MISSING';
    const out = substituteRow(html, row({ t: 'Hi', u: 'http://x' }), { TITLE: 't', URL: 'u' });
    expect(out).toBe('<a href="http://x">Hi</a>');
  });

  it('extractTokens strips the input. prefix so $X and $input.X share one key', () => {
    expect(extractTokens('$input.CHECK1 $input:CHECK2 $TITLE $input.TITLE').sort()).toEqual(['CHECK1', 'CHECK2', 'TITLE']);
  });

  it('renders a checked, wired checkbox for an $input.TOKEN over a boolean field', () => {
    const cols = new Map([['read', col('read', 'boolean', 'Read?')]]);
    const out = substituteRow('$input.MARKREAD', row({ read: true }), { MARKREAD: 'read' }, { columns: cols });
    expect(out).toContain('type="checkbox"');
    expect(out).toContain('class="eda-input"');
    expect(out).toContain('data-eda-row="r"');
    expect(out).toContain('data-eda-field="read"');
    expect(out).toContain('data-eda-type="boolean"');
    expect(out).toContain(' checked');
    expect(out).not.toContain('disabled');
    expect(out).toContain('Read?'); // caption from the column label
  });

  it('leaves the checkbox unchecked for falsy values and honours readonly (disabled)', () => {
    const cols = new Map([['read', col('read', 'boolean')]]);
    const off = substituteRow('$input.R', row({ read: 0 }), { R: 'read' }, { columns: cols });
    expect(off).not.toContain(' checked');
    const ro = substituteRow('$input.R', row({ read: true }), { R: 'read' }, { columns: cols, readonly: true });
    expect(ro).toContain('disabled');
  });

  it('renders number/text inputs for non-boolean $input.TOKENs, escaping the value', () => {
    const cols = new Map([
      ['qty', col('qty', 'number')],
      ['note', col('note', 'string')],
    ]);
    const num = substituteRow('$input.N', row({ qty: 5 }), { N: 'qty' }, { columns: cols });
    expect(num).toContain('type="number"');
    expect(num).toContain('value="5"');
    const txt = substituteRow('$input.T', row({ note: 'a "b" <c>' }), { T: 'note' }, { columns: cols });
    expect(txt).toContain('type="text"');
    expect(txt).toContain('value="a &quot;b&quot; &lt;c&gt;"');
  });

  it('a plain (non-input) token still renders the read-only value even with columns provided', () => {
    const cols = new Map([['read', col('read', 'boolean')]]);
    const out = substituteRow('$READ', row({ read: true }), { READ: 'read' }, { columns: cols });
    expect(out).toBe('true');
  });

  it('an unmapped $input.TOKEN renders nothing', () => {
    expect(substituteRow('$input.NOPE', row({}), {}, {})).toBe('');
  });

  it('filters case-insensitively and ANDs multiple columns', () => {
    const rows = [row({ a: 'Apple', b: 'red' }), row({ a: 'Banana', b: 'yellow' })];
    expect(filterRows(rows, { a: 'app' })).toHaveLength(1);
    expect(filterRows(rows, { a: 'a', b: 'zzz' })).toHaveLength(0);
    expect(filterRows(rows, {})).toHaveLength(2);
  });

  it('sorts empties to the bottom in BOTH directions', () => {
    const rows = [row({ n: 2 }), row({ n: null }), row({ n: 1 })];
    expect(sortRows(rows, 'n', true).map((r) => r.data.n)).toEqual([1, 2, null]);
    expect(sortRows(rows, 'n', false).map((r) => r.data.n)).toEqual([2, 1, null]);
  });

  it('viewRows filters then sorts', () => {
    const rows = [row({ n: 3, k: 'x' }), row({ n: 1, k: 'y' }), row({ n: 2, k: 'x' })];
    const out = viewRows(rows, { filters: { k: 'x' }, sortColumn: 'n', sortAsc: true });
    expect(out.map((r) => r.data.n)).toEqual([2, 3]);
  });

  it('hasRowHtml treats whitespace as empty', () => {
    expect(hasRowHtml('   \n')).toBe(false);
    expect(hasRowHtml(undefined)).toBe(false);
    expect(hasRowHtml('<div>$X</div>')).toBe(true);
  });

  it('extractTokens finds filter.-prefixed tokens under the bare name', () => {
    expect(extractTokens('$filter.TAG $filter:STATUS $TAG').sort()).toEqual(['STATUS', 'TAG']);
  });

  /**
   * The view window puts a chip in its toolbar for every filter the TEMPLATE
   * offers, so it has to know which tokens are `filter.` ones — a plain `$TAG`
   * offers no filter, and an `$input.TAG` is an editor.
   */
  describe('extractFilterTokens', () => {
    it('returns only the filter.-prefixed tokens, in the order they appear', () => {
      expect(extractFilterTokens('<div>$NAME $filter.TAG $input.NOTE $filter:STATUS</div>')).toEqual(['TAG', 'STATUS']);
    });

    it('reads across fragments and returns each name once', () => {
      expect(extractFilterTokens('$filter.TAG', '', '$filter.TAG $filter.OWNER')).toEqual(['TAG', 'OWNER']);
    });

    it('is empty when a template offers no filter at all', () => {
      expect(extractFilterTokens('<div>$NAME $input.AGE</div>', '', '')).toEqual([]);
    });
  });

  it('$filter.TOKEN renders a clickable pill with field/value data attributes', () => {
    const out = substituteRow('$filter.TAG', row({ tag: 'foo' }), { TAG: 'tag' });
    expect(out).toContain('class="eda-filter-pill"');
    expect(out).toContain('data-eda-filter-field="tag"');
    expect(out).toContain('data-eda-filter-value="foo"');
    expect(out).toContain('>foo</button>');
    expect(out).toContain('<button type="button"');
  });

  it('$filter.TOKEN escapes the field/value attributes and text', () => {
    const out = substituteRow('$filter.TAG', row({ tag: '"><script>' }), { TAG: 'tag' });
    expect(out).not.toContain('"><script>');
    expect(out).toContain('&lt;script&gt;');
  });

  it('a null/empty value renders no pill at all', () => {
    expect(substituteRow('$filter.TAG', row({ tag: null }), { TAG: 'tag' })).toBe('');
    expect(substituteRow('$filter.TAG', row({ tag: '' }), { TAG: 'tag' })).toBe('');
    expect(substituteRow('$filter.NOPE', row({}), {})).toBe('');
  });

  /**
   * An `array` cell holds several values, so `$filter.TAGS` is several chips —
   * one per member, each filtering on that member alone. One chip for the whole
   * cell filtered on `=foo,bar`, which no list cell is ever exactly equal to, so
   * clicking it emptied the view.
   */
  describe('$filter.TOKEN over an array field', () => {
    const arrayCols = new Map([['tags', col('tags', 'array')]]);
    const pills = (out: string) => [...out.matchAll(/data-eda-filter-value="([^"]*)"/g)].map((m) => m[1]);

    it('renders one pill per member of a comma list', () => {
      const out = substituteRow('$filter.TAGS', row({ tags: 'foo, bar' }), { TAGS: 'tags' }, { columns: arrayCols });
      expect(pills(out)).toEqual(['foo', 'bar']);
      expect(out).toContain('>foo</button>');
      expect(out).toContain('>bar</button>');
    });

    it('renders one pill per member of a JSON-array cell', () => {
      const out = substituteRow('$filter.TAGS', row({ tags: '["Foo","Bar"]' }), { TAGS: 'tags' }, { columns: arrayCols });
      expect(pills(out)).toEqual(['Foo', 'Bar']);
    });

    it('takes a real JS array apart even where the column says otherwise', () => {
      // `String(['a','b'])` is `a,b`, so a pill of the whole value could never
      // match — a real array is a list whatever the column type claims.
      const out = substituteRow('$filter.TAGS', row({ tags: ['a', 'b'] }), { TAGS: 'tags' }, { columns: new Map([['tags', col('tags', 'string')]]) });
      expect(pills(out)).toEqual(['a', 'b']);
    });

    it('renders nothing for an empty list', () => {
      for (const tags of ['', '[]', null, []]) {
        expect(substituteRow('$filter.TAGS', row({ tags }), { TAGS: 'tags' }, { columns: arrayCols })).toBe('');
      }
    });

    it('escapes each member', () => {
      const out = substituteRow('$filter.TAGS', row({ tags: '<script>,ok' }), { TAGS: 'tags' }, { columns: arrayCols });
      expect(out).not.toContain('<script>');
      expect(out).toContain('&lt;script&gt;');
      expect(pills(out)).toEqual(['&lt;script&gt;', 'ok']);
    });

    it('a chip keeps the rows carrying that one member', () => {
      const rows = [
        { id: 'a', tableId: 't', data: { tags: 'foo,bar' }, updatedAt: 0 },
        { id: 'b', tableId: 't', data: { tags: 'bar' }, updatedAt: 0 },
        { id: 'c', tableId: 't', data: { tags: 'baz' }, updatedAt: 0 },
      ];
      const kept = filterRows(rows, { tags: addPillValue(undefined, 'foo') }, [col('tags', 'array')]);
      expect(kept.map((r) => r.id)).toEqual(['a']);
    });

    it('a non-array column still renders the one pill it always did', () => {
      const out = substituteRow('$filter.TAGS', row({ tags: 'foo,bar' }), { TAGS: 'tags' }, { columns: new Map([['tags', col('tags', 'string')]]) });
      expect(pills(out)).toEqual(['foo,bar']);
    });
  });

  it('$TOKEN and $input.TOKEN rendering is unchanged', () => {
    expect(substituteRow('$TAG', row({ tag: 'foo' }), { TAG: 'tag' })).toBe('foo');
    const cols = new Map([['tag', col('tag', 'string')]]);
    expect(substituteRow('$input.TAG', row({ tag: 'foo' }), { TAG: 'tag' }, { columns: cols })).toContain('type="text"');
  });

  describe('addPillValue / removePillValue', () => {
    it('addPillValue appends an exact-match token', () => {
      expect(addPillValue(undefined, 'foo')).toBe('=foo');
      expect(addPillValue('', 'foo')).toBe('=foo');
    });

    it('addPillValue OR-appends a second value on the same field', () => {
      expect(addPillValue('=foo', 'bar')).toBe('=foo,=bar');
    });

    it('addPillValue is idempotent — clicking the same value twice leaves one token', () => {
      expect(addPillValue('=foo', 'foo')).toBe('=foo');
      expect(addPillValue('=foo,=bar', 'Foo')).toBe('=foo,=bar'); // case-insensitive
    });

    it('addPillValue preserves tokens already present', () => {
      expect(addPillValue('=foo', 'bar')).toBe('=foo,=bar');
    });

    it('removePillValue removes one token, case-insensitively', () => {
      expect(removePillValue('=foo,=bar', 'foo')).toBe('=bar');
      expect(removePillValue('=foo,=bar', 'BAR')).toBe('=foo');
    });

    it('removePillValue returns empty string when nothing is left', () => {
      expect(removePillValue('=foo', 'foo')).toBe('');
      expect(removePillValue(undefined, 'foo')).toBe('');
    });
  });

  describe('pillValueState / cyclePillValue', () => {
    // What a chip's FIELD button does: = (only this) → ≠ (everything but this)
    // → off. Three states, because "everything except this" is the other half of
    // a filter you arrived at by clicking a value.
    it('reads the state of one value', () => {
      expect(pillValueState(undefined, 'foo')).toBe('off');
      expect(pillValueState('=foo', 'foo')).toBe('on');
      expect(pillValueState('!=foo', 'foo')).toBe('not');
      expect(pillValueState('=bar', 'foo')).toBe('off');
    });

    it('reads the state case-insensitively, like the filter matches', () => {
      expect(pillValueState('=Foo', 'foo')).toBe('on');
      expect(pillValueState('!=FOO', 'foo')).toBe('not');
    });

    it('cycles off → on → not → off', () => {
      expect(cyclePillValue(undefined, 'foo')).toBe('=foo');
      expect(cyclePillValue('=foo', 'foo')).toBe('!=foo');
      expect(cyclePillValue('!=foo', 'foo')).toBe('');
    });

    it('leaves the other values on the same field alone', () => {
      expect(cyclePillValue('=foo,=bar', 'foo')).toBe('=bar,!=foo');
      expect(cyclePillValue('=foo,!=bar', 'bar')).toBe('=foo');
    });

    it('ignores a non-exact token for the same term — that is a different filter', () => {
      // `^foo` (starts-with) is not the exact-match token a chip owns, so it
      // survives the cycle rather than being silently rewritten.
      expect(cyclePillValue('^foo', 'foo')).toBe('^foo,=foo');
    });
  });

  describe('scripted columns', () => {
    const scripted = (field: string, script: string): ColumnSpec => ({
      field,
      label: field,
      type: 'string',
      script,
    });

    it('puts a script result under the column field', () => {
      const cols = [col('a', 'number'), scripted('double', 'function render(row){return row.a*2}')];
      const out = evaluateRow(row({ a: 21 }), cols);
      expect(out.data.double).toBe(42);
      expect(out.data.a).toBe(21); // the stored cells are untouched
    });

    it('leaves a row without scripted columns as the same object', () => {
      const r = row({ a: 1 });
      expect(evaluateRow(r, [col('a', 'number')])).toBe(r);
    });

    it('shows a broken script as an error label, not as an empty cell', () => {
      const threw = evaluateRow(row({ a: 1 }), [scripted('x', 'function render(){ boom() }')]);
      expect(threw.data.x).toBe('⚠ runtime error');
      const wont = evaluateRow(row({ a: 1 }), [scripted('x', 'function render( {')]);
      expect(wont.data.x).toBe('⚠ compile error');
    });

    it('a template token shows the computed value', () => {
      const spec = scripted('full', 'function render(r){return r.a+" "+r.b}');
      const cols = new Map([['full', spec]]);
      const evaluated = evaluateRow(row({ a: 'Ada', b: 'L' }), [spec]);
      const out = substituteRow('<b>$NAME</b>', evaluated, { NAME: 'full' }, { columns: cols });
      expect(out).toBe('<b>Ada L</b>');
    });

    it('an $input on a scripted column is disabled — a computed cell has nothing to write to', () => {
      const cols = new Map([['calc', scripted('calc', 'function render(r){return r.a}')]]);
      const opts = { columns: cols };
      const out = substituteRow('$input.CALC', row({ a: 'x', calc: 'x' }), { CALC: 'calc' }, opts);
      expect(out).toContain('disabled');
    });

    it('a view filters and sorts on the computed value', () => {
      const cols = [scripted('kind', 'function render(r){return r.n % 2 ? "odd" : "even"}')];
      const rows = evaluateRows([row({ n: 1 }), row({ n: 2 }), row({ n: 3 }), row({ n: 4 })], cols);
      const out = viewRows(rows, { filters: { kind: 'even' }, sortColumn: 'n', sortAsc: false });
      expect(out.map((r) => r.data.n)).toEqual([4, 2]);
    });

    it('evaluateRows returns the same list when nothing is scripted', () => {
      const rows = [row({ a: 1 })];
      expect(evaluateRows(rows, [col('a', 'number')])).toBe(rows);
    });
  });

  // A `$TOKEN` shows what the GRID shows — the value through the column's own
  // cell renderer. A renderer is a custom element fed by properties, so what
  // lands in the string is an empty slot the view window mounts into; these
  // tests are about WHEN a slot is emitted and when the token stays plain text.
  describe('rendered vs raw tokens', () => {
    const renderers = new Map([['link', 'cell-link']]);
    const linkCol = new Map([['u', { field: 'u', label: 'u', type: 'string' as const, renderer: 'link' }]]);
    const sub = (html: string, over: Record<string, unknown> = {}) => substituteRow(html, row({ u: 'http://x', plain: 'text' }), { URL: 'u', P: 'plain' }, { columns: linkCol, renderers, ...over });

    it('emits a slot naming the row, the field, the token and the renderer tag', () => {
      const out = sub('$URL');
      expect(out).toContain('class="eda-cell"');
      expect(out).toContain('data-eda-row="r"');
      expect(out).toContain('data-eda-field="u"');
      expect(out).toContain('data-eda-token="URL"');
      expect(out).toContain('data-eda-tag="cell-link"');
      // The slot is empty: only the DOM pass can set a renderer's properties.
      expect(out).toContain('></span>');
    });

    it('$raw.TOKEN and the per-token toggle both fall back to the plain value', () => {
      expect(sub('$raw.URL')).toBe('http://x');
      expect(sub('$URL', { raw: { URL: true } })).toBe('http://x');
      // The toggle is per token, so its neighbour is unaffected.
      expect(sub('$URL', { raw: { OTHER: true } })).toContain('eda-cell');
    });

    it('a column with no renderer, or an unregistered one, stays plain text', () => {
      expect(sub('$P')).toBe('text');
      expect(sub('$URL', { renderers: new Map() })).toBe('http://x');
      // No renderers passed at all — the pre-renderer behaviour, unchanged.
      expect(substituteRow('$URL', row({ u: 'http://x' }), { URL: 'u' }, { columns: linkCol })).toBe('http://x');
    });

    it('a token INSIDE a tag stays plain — an element in an attribute is a broken tag', () => {
      // How the shipped Gallery and RSS templates are written.
      expect(sub('<img src="$URL">')).toBe('<img src="http://x">');
      expect(sub("<a href='$URL'>go</a>")).toBe("<a href='http://x'>go</a>");
      expect(sub('<a data-x=$URL>')).toBe('<a data-x=http://x>');
      // Text content after the tag closes IS rendered.
      expect(sub('<a href="$URL">$URL</a>')).toContain('eda-cell');
    });

    it('a scripted token is not sent through the renderer — the script already decided', () => {
      const out = sub('$URL', { scripts: { URL: 'function render(){ return "computed" }' } });
      expect(out).toBe('computed');
    });

    it('$input. and $filter. are untouched by any of this', () => {
      expect(sub('$input.URL')).toContain('<input');
      expect(sub('$filter.URL')).toContain('eda-filter-pill');
    });

    it('tokenValue is the one rule for what a token shows, script or stored cell', () => {
      const r = row({ a: 'stored' });
      expect(tokenValue(r, 'a')).toBe('stored');
      expect(tokenValue(r, 'a', '  ')).toBe('stored');
      expect(tokenValue(r, 'a', 'function render(x){ return x.a.toUpperCase() }')).toBe('STORED');
      expect(tokenValue(r, 'a', 'function render(){ boom() }')).toBe('⚠ runtime error');
    });
  });

  // A token script formats what the VIEW shows. The stored cell is not touched,
  // which is the whole point: the same column can read one way in the grid and
  // another in a card.
  describe('token scripts', () => {
    it('a scripted token shows what the script returns, not the stored value', () => {
      const out = substituteRow('$WHEN', row({ d: '2026-06-17T10:59:56.937Z' }), { WHEN: 'd' }, { scripts: { WHEN: 'function render(r){ return new Date(r.d).getUTCFullYear() }' } });
      expect(out).toBe('2026');
    });

    it('the result is HTML, so markdownToHtml formats the cell', () => {
      const out = substituteRow('$BODY', row({ body: '# Title' }), { BODY: 'body' }, { scripts: { BODY: 'function render(r){ return markdownToHtml(r.body) }' } });
      expect(out).toContain('<h1');
      expect(out).toContain('Title');
    });

    it('a scripted token needs no mapped column — it reads the whole row', () => {
      const out = substituteRow('$SUM', row({ a: 2, b: 3 }), {}, { scripts: { SUM: 'function render(r){ return r.a + r.b }' } });
      expect(out).toBe('5');
    });

    it('leaves $input and $filter on the mapped column — one writes back, the other must match the stored text', () => {
      const cols = new Map([['t', col('t', 'string')]]);
      const scripts = { T: 'function render(){ return "SHOUTED" }' };
      expect(substituteRow('$input.T', row({ t: 'quiet' }), { T: 't' }, { columns: cols, scripts })).toContain('value="quiet"');
      expect(substituteRow('$filter.T', row({ t: 'quiet' }), { T: 't' }, { columns: cols, scripts })).toContain('data-eda-filter-value="quiet"');
    });

    it('shows a broken script as an error chip, never as an empty value', () => {
      const threw = substituteRow('$X', row({}), {}, { scripts: { X: 'function render(){ boom() }' } });
      expect(threw).toContain('⚠ runtime error');
      const wont = substituteRow('$X', row({}), {}, { scripts: { X: 'function render( {' } });
      expect(wont).toContain('⚠ compile error');
    });

    it('a blank script or a null result renders nothing, and an unscripted token is untouched', () => {
      expect(substituteRow('$T', row({ t: 'kept' }), { T: 't' }, { scripts: { T: '   ' } })).toBe('kept');
      expect(substituteRow('$T', row({ t: 'kept' }), { T: 't' }, { scripts: { OTHER: 'function render(){return 1}' } })).toBe('kept');
      expect(substituteRow('$T', row({ t: 'kept' }), { T: 't' }, { scripts: { T: 'function render(){ return null }' } })).toBe('');
    });
  });

  it('viewRows ANDs the filters and pillFilters layers, then sorts', () => {
    const rows = [row({ n: 3, k: 'x', tag: 'a' }), row({ n: 1, k: 'y', tag: 'a' }), row({ n: 2, k: 'x', tag: 'b' }), row({ n: 4, k: 'x', tag: 'a' })];
    const out = viewRows(rows, {
      filters: { k: 'x' },
      pillFilters: { tag: '=a' },
      sortColumn: 'n',
      sortAsc: true,
    });
    expect(out.map((r) => r.data.n)).toEqual([3, 4]);
  });
});
