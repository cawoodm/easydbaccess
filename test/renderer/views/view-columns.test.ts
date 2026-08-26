import { describe, expect, it } from 'vitest';
import type { ColumnSpec } from '../../../packages/shared/src/types.js';
import { setViewRenderer, toggleViewColumn, viewColumnSpec, viewColumnSpecs, viewRenderer } from '../../../packages/renderer/src/views/view-columns.js';

/**
 * A view's own column presentation.
 *
 * The table owns what a column IS; the view owns how it looks. These are the
 * rules both render paths share — `data-table`'s `applyView` for the grid, and
 * `view-window`'s `$TOKEN` substitution for a template — so a view cannot look
 * one way as a grid and another through its template.
 */

const col = (field: string, over: Partial<ColumnSpec> = {}): ColumnSpec => ({ field, label: field.toUpperCase(), type: 'string', ...over });

const TABLE: ColumnSpec[] = [col('name'), col('body', { renderer: 'markdown' }), col('url', { renderer: 'link' })];

describe('viewRenderer', () => {
  it('follows the table when the view has no opinion', () => {
    expect(viewRenderer(col('body', { renderer: 'markdown' }), undefined)).toBe('markdown');
    expect(viewRenderer(col('body', { renderer: 'markdown' }), {})).toBe('markdown');
  });

  it('is the view´s choice where it has one', () => {
    expect(viewRenderer(col('body', { renderer: 'markdown' }), { body: 'preview' })).toBe('preview');
  });

  it('treats a stored blank as "from the table", not as "no renderer"', () => {
    // The empty option in the picker means inherit. A view has no way to mean
    // "draw this as nothing", so a blank can only be the first of the two.
    expect(viewRenderer(col('body', { renderer: 'markdown' }), { body: '' })).toBe('markdown');
    expect(viewRenderer(col('body', { renderer: 'markdown' }), { body: '   ' })).toBe('markdown');
  });

  it('leaves a column with no renderer either way alone', () => {
    expect(viewRenderer(col('name'), {})).toBeUndefined();
  });

  it('gives a renderer to a column the table draws as plain text', () => {
    expect(viewRenderer(col('name'), { name: 'link' })).toBe('link');
  });
});

describe('viewColumnSpec', () => {
  it('replaces the renderer and the width, and nothing else', () => {
    const source = col('body', { renderer: 'markdown', type: 'string', notnull: true, unique: true, max: 40 });
    const out = viewColumnSpec(source, { renderers: { body: 'preview' }, widths: { body: 220 } });
    expect(out.renderer).toBe('preview');
    expect(out.width).toBe(220);
    // What the column IS travels untouched: the grid writes THROUGH a view, and
    // these are what keep that write honest.
    expect(out).toMatchObject({ field: 'body', label: 'BODY', type: 'string', notnull: true, unique: true, max: 40 });
  });

  it('does not invent a width', () => {
    expect(viewColumnSpec(col('name'), {})).not.toHaveProperty('width');
  });

  it('leaves the source column untouched', () => {
    const source = col('body', { renderer: 'markdown' });
    viewColumnSpec(source, { renderers: { body: 'preview' } });
    expect(source.renderer).toBe('markdown');
  });

  it('drops the renderer key entirely when neither side has one', () => {
    // `exactOptionalPropertyTypes` is on, and `{renderer: undefined}` is not the
    // same shape as a column with no renderer at all.
    expect('renderer' in viewColumnSpec(col('name'), {})).toBe(false);
  });
});

describe('viewColumnSpecs', () => {
  it('is the view´s columns in the view´s order', () => {
    expect(viewColumnSpecs(TABLE, ['url', 'name']).map((c) => c.field)).toEqual(['url', 'name']);
  });

  it('drops a field the table no longer has rather than faking a column', () => {
    // Views bind to tables by NAME and survive a delete-and-reimport, so a
    // narrower new copy leaves stale fields behind in `visibleColumns`.
    expect(viewColumnSpecs(TABLE, ['name', 'gone']).map((c) => c.field)).toEqual(['name']);
  });

  it('applies the view´s renderers', () => {
    const out = viewColumnSpecs(TABLE, ['body', 'url'], { renderers: { body: 'preview' } });
    expect(out.map((c) => c.renderer)).toEqual(['preview', 'link']);
  });

  it('shows nothing for an empty visible list', () => {
    expect(viewColumnSpecs(TABLE, [])).toEqual([]);
  });
});

describe('toggleViewColumn', () => {
  const order = TABLE.map((c) => c.field);

  it('hides a column that is showing', () => {
    expect(toggleViewColumn(['name', 'body'], order, 'body')).toEqual(['name']);
  });

  it('puts a column back where the TABLE has it, not at the end', () => {
    // `visibleColumns` is also the column order, so appending made hiding and
    // showing a column move it to the far right for no reason the user can see.
    expect(toggleViewColumn(['name', 'url'], order, 'body')).toEqual(['name', 'body', 'url']);
  });

  it('refuses to hide the last visible column', () => {
    // A grid with no columns shows nothing and offers no way back.
    expect(toggleViewColumn(['name'], order, 'name')).toBeNull();
  });

  it('keeps a field the table has dropped rather than reordering it away', () => {
    expect(toggleViewColumn(['gone', 'name'], order, 'url')).toEqual(['name', 'url', 'gone']);
  });

  it('is its own inverse for a column in the middle', () => {
    const hidden = toggleViewColumn(['name', 'body', 'url'], order, 'body');
    expect(hidden).toEqual(['name', 'url']);
    expect(toggleViewColumn(hidden!, order, 'body')).toEqual(['name', 'body', 'url']);
  });
});

describe('setViewRenderer', () => {
  it('records a choice', () => {
    expect(setViewRenderer(undefined, 'body', 'preview')).toEqual({ body: 'preview' });
  });

  it('writes "from the table" as an ABSENCE, not as an empty string', () => {
    // A view that stored '' for every column could never be told from one that
    // holds no opinion at all.
    expect(setViewRenderer({ body: 'preview' }, 'body', '')).toEqual({});
    expect(setViewRenderer({ body: 'preview', url: 'link' }, 'body', '  ')).toEqual({ url: 'link' });
  });

  it('leaves the other columns alone', () => {
    expect(setViewRenderer({ url: 'link' }, 'body', 'preview')).toEqual({ url: 'link', body: 'preview' });
  });

  it('does not mutate what it was given', () => {
    const before = { url: 'link' };
    setViewRenderer(before, 'body', 'preview');
    expect(before).toEqual({ url: 'link' });
  });
});
