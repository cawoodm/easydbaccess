import { describe, expect, it } from 'vitest';
import type { ColumnSpec, Row, ViewInstance, ViewTemplate } from '@easydb/shared';
import { cardColumns, generatedCardHtml, identityMapping, isEmptyLayout, recordLayoutFor, startingHtml } from '../../../packages/renderer/src/views/record-html.js';
import { substituteRow } from '../../../packages/renderer/src/views/view-render.js';

/**
 * A record layout's tokens are COLUMN NAMES, not mapping keys.
 *
 * That is the whole difference from a view template, and it is bought with an
 * identity mapping rather than with a second token language — so the tests that
 * matter most here drive `substituteRow` itself and assert that every prefix
 * behaves exactly as it does in a view.
 */

const col = (field: string, over: Partial<ColumnSpec> = {}): ColumnSpec => ({ field, label: field, type: 'string', ...over }) as ColumnSpec;

const COLUMNS: ColumnSpec[] = [col('title'), col('body', { type: 'text' }), col('done', { type: 'boolean' })];

const row: Row = { id: 'r1', tableId: 't1', updatedAt: 0, data: { title: 'Berlin', body: 'A long note', done: true } };

describe('identityMapping', () => {
  it('maps every column to itself', () => {
    expect(identityMapping(COLUMNS)).toEqual({ title: 'title', body: 'body', done: 'done' });
  });

  it('is built from the COLUMNS, not from the row', () => {
    // A token naming a column that is empty on this record must still resolve —
    // otherwise a layout would behave differently depending on which record you
    // happened to be looking at.
    const empty: Row = { id: 'r2', tableId: 't1', updatedAt: 0, data: {} };
    const out = substituteRow('$title', empty, identityMapping(COLUMNS), {});
    expect(out).toBe('');
  });
});

describe('a token is its own field name', () => {
  const opts = { columns: new Map(COLUMNS.map((c) => [c.field, c])) };

  it('renders a plain $field as the value', () => {
    expect(substituteRow('<p>$title</p>', row, identityMapping(COLUMNS), opts)).toBe('<p>Berlin</p>');
  });

  it('renders $raw.field as the stored text', () => {
    expect(substituteRow('$raw.title', row, identityMapping(COLUMNS), opts)).toBe('Berlin');
  });

  it('renders $input.field as a control bound to that cell', () => {
    const out = substituteRow('$input.title', row, identityMapping(COLUMNS), opts);
    expect(out).toContain('class="eda-input"');
    expect(out).toContain('data-eda-row="r1"');
    expect(out).toContain('data-eda-field="title"');
    expect(out).toContain('value="Berlin"');
  });

  it('types the control from the column', () => {
    const out = substituteRow('$input.done', row, identityMapping(COLUMNS), opts);
    expect(out).toContain('type="checkbox"');
    expect(out).toContain('checked');
  });

  it('disables every control when the pane is read-only', () => {
    const out = substituteRow('$input.title', row, identityMapping(COLUMNS), { ...opts, readonly: true });
    expect(out).toContain('disabled');
  });

  it('renders a token naming no column as nothing', () => {
    expect(substituteRow('[$nosuch]', row, identityMapping(COLUMNS), opts)).toBe('[]');
  });

  it('leaves everything that is not a token exactly as written', () => {
    expect(substituteRow('<h2 class="x">hello</h2>', row, identityMapping(COLUMNS), opts)).toBe('<h2 class="x">hello</h2>');
  });
});

describe('cardColumns', () => {
  it('is every column when nothing is hidden', () => {
    expect(cardColumns(COLUMNS).map((c) => c.field)).toEqual(['title', 'body', 'done']);
  });

  it("keeps the table's order, not the visible list's", () => {
    // The visible list is a set of names; the card reads left to right like the
    // grid does.
    expect(cardColumns(COLUMNS, ['done', 'title']).map((c) => c.field)).toEqual(['title', 'done']);
  });

  it('treats an empty visible list as "everything"', () => {
    expect(cardColumns(COLUMNS, []).map((c) => c.field)).toEqual(['title', 'body', 'done']);
  });
});

describe('generatedCardHtml', () => {
  it('is a label and a token per column', () => {
    const out = generatedCardHtml(COLUMNS);
    expect(out).toContain('<div class="eda-rec-label">title</div>');
    expect(out).toContain('<div class="eda-rec-value">$title</div>');
    expect(out).toContain('<div class="eda-rec-value">$done</div>');
  });

  it('goes through the same substitution a hand-written layout does', () => {
    // One code path. The generated card is token HTML, not a second renderer.
    const out = substituteRow(generatedCardHtml(COLUMNS), row, identityMapping(COLUMNS), { columns: new Map(COLUMNS.map((c) => [c.field, c])) });
    expect(out).toContain('Berlin');
    expect(out).toContain('A long note');
  });

  it('can be generated editable', () => {
    expect(generatedCardHtml(COLUMNS, { editable: true })).toContain('$input.title');
  });

  it('escapes a label, and does not turn one into a token', () => {
    // A column labelled `Cost $` must not produce `$` followed by whatever comes
    // next — labels go in as text, values as tokens, which is why they are built
    // separately.
    const out = generatedCardHtml([col('cost', { label: 'Cost <b>$</b>' })]);
    expect(out).toContain('Cost &lt;b&gt;$&lt;/b&gt;');
    expect(out).toContain('<div class="eda-rec-value">$cost</div>');
  });
});

describe('startingHtml', () => {
  it('is the card that was on screen, so the first edit is a change not a blank page', () => {
    const out = startingHtml(COLUMNS);
    // The EDITABLE markup, because that is what an empty layout draws. A
    // starting point that differs from what was on screen a moment ago is a
    // puzzle rather than a head start.
    expect(out).toContain('$input.title');
    expect(out).toBe(generatedCardHtml(COLUMNS, { editable: true }));
  });
});

describe('recordLayoutFor', () => {
  const inst = (id: string, tableId: string, templateId: string): ViewInstance =>
    ({ id, workspaceId: 'w', tableId, templateId, name: id, filters: {}, visibleColumns: [], updatedAt: 0 }) as unknown as ViewInstance;
  const tpl = (id: string, kind: 'html' | 'viz', vizKind?: string, html?: string): ViewTemplate =>
    ({
      id,
      workspaceId: 'w',
      name: id,
      headerHtml: '',
      rowHtml: '',
      footerHtml: '',
      kind,
      ...(vizKind ? { viz: { kind: vizKind, options: html === undefined ? {} : { html } } } : {}),
      updatedAt: 0,
    }) as unknown as ViewTemplate;

  it('finds the html of a record template bound to this table', () => {
    const out = recordLayoutFor([inst('i1', 't1', 'tpl1')], [tpl('tpl1', 'viz', 'record', '<b>$title</b>')], 't1');
    expect(out).toBe('<b>$title</b>');
  });

  it('ignores an instance of ANOTHER table', () => {
    // "The table's layout" means bound to THIS table. A record template used on
    // a different table is not this one's.
    expect(recordLayoutFor([inst('i1', 't2', 'tpl1')], [tpl('tpl1', 'viz', 'record', '<b>x</b>')], 't1')).toBe('');
  });

  it('ignores a chart and an html template', () => {
    const instances = [inst('i1', 't1', 'bar'), inst('i2', 't1', 'card')];
    const templates = [tpl('bar', 'viz', 'bar', '<b>x</b>'), tpl('card', 'html')];
    expect(recordLayoutFor(instances, templates, 't1')).toBe('');
  });

  it('skips a record template whose layout is empty', () => {
    // An empty layout is "draw the generated card", so it is not a layout to
    // carry into the window — the window generates its own, editable.
    const instances = [inst('i1', 't1', 'blank'), inst('i2', 't1', 'real')];
    const templates = [tpl('blank', 'viz', 'record', '   '), tpl('real', 'viz', 'record', '<b>$title</b>')];
    expect(recordLayoutFor(instances, templates, 't1')).toBe('<b>$title</b>');
  });

  it('is stable when a table has two record layouts', () => {
    // Sorted by id, so the window draws the same one every time rather than
    // whichever the store happened to return first.
    const instances = [inst('i2', 't1', 'b'), inst('i1', 't1', 'a')];
    const templates = [tpl('a', 'viz', 'record', 'A'), tpl('b', 'viz', 'record', 'B')];
    expect(recordLayoutFor(instances, templates, 't1')).toBe('A');
    expect(recordLayoutFor([...instances].reverse(), templates, 't1')).toBe('A');
  });

  it('survives an instance whose template is gone', () => {
    expect(recordLayoutFor([inst('i1', 't1', 'missing')], [], 't1')).toBe('');
  });
});

describe('isEmptyLayout', () => {
  it('is true for absent, empty and whitespace-only', () => {
    expect(isEmptyLayout(undefined)).toBe(true);
    expect(isEmptyLayout('')).toBe(true);
    // A textarea opened, looked at and closed must not turn the card off.
    expect(isEmptyLayout('  \n\t ')).toBe(true);
  });

  it('is false for any real markup', () => {
    expect(isEmptyLayout('<p>$title</p>')).toBe(false);
  });
});
