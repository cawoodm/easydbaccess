import { describe, expect, it } from 'vitest';
import type { ColumnSpec } from '@easydb/shared';
import { findColumn, keyColumnOf, planPreview, previewFieldOf } from '../../../packages/renderer/src/plugins/commandlet-preview.js';

/**
 * `preview/<table>/<a>` and `preview/<table>/<a>/<b>` — the rules that decide
 * whether `a` is a field or a key, and which field a key-only form shows.
 *
 * The interesting cases are all ambiguity: two targets look identical whether the
 * second is a column name or a record id, and only the table's own columns can
 * tell them apart.
 */

const col = (field: string, over: Partial<ColumnSpec> = {}): ColumnSpec => ({ field, label: field, type: 'string', ...over });

const table = (...columns: ColumnSpec[]) => ({ columns });

describe('findColumn', () => {
  const t = table(col('id'), col('body', { label: 'Body text' }));

  it('matches a field name, case-insensitively', () => {
    expect(findColumn(t.columns, 'BODY')?.field).toBe('body');
  });

  it('matches a label when no field matches', () => {
    expect(findColumn(t.columns, 'body text')?.field).toBe('body');
  });

  it('prefers a FIELD match over a label match on another column', () => {
    // A column labelled with another column's field name is a trap: the field is
    // the technical identity, so it wins.
    const tricky = table(col('body'), col('notes', { label: 'body' }));
    expect(findColumn(tricky.columns, 'body')?.field).toBe('body');
  });

  it('is undefined for an unknown name, and for blank', () => {
    expect(findColumn(t.columns, 'nope')).toBeUndefined();
    expect(findColumn(t.columns, '   ')).toBeUndefined();
  });
});

describe('keyColumnOf', () => {
  it('is the first column, hidden or not', () => {
    expect(keyColumnOf(table(col('id', { hidden: true }), col('name')))?.field).toBe('id');
  });

  it('is undefined for a table with no columns', () => {
    expect(keyColumnOf(table())).toBeUndefined();
  });
});

describe('previewFieldOf', () => {
  it('prefers a column with a preview renderer', () => {
    const t = table(col('id'), col('name'), col('notes', { renderer: 'preview' }));
    expect(previewFieldOf(t)?.field).toBe('notes');
  });

  it('takes markdown as a preview renderer too', () => {
    const t = table(col('id'), col('name'), col('body', { renderer: 'markdown' }));
    expect(previewFieldOf(t)?.field).toBe('body');
  });

  it('falls back to a text column when no renderer says so', () => {
    const t = table(col('id'), col('name'), col('story', { type: 'text' }));
    expect(previewFieldOf(t)?.field).toBe('story');
  });

  it('prefers the preview renderer over an earlier text column', () => {
    // The renderer is someone's explicit statement that the column is too long
    // for its cell; the type is an inference made at import time.
    const t = table(col('id'), col('story', { type: 'text' }), col('body', { renderer: 'markdown' }));
    expect(previewFieldOf(t)?.field).toBe('body');
  });

  it('falls back to the first non-key column', () => {
    expect(previewFieldOf(table(col('id'), col('name'), col('qty')))?.field).toBe('name');
  });

  it('never picks the key column while another exists', () => {
    // Previewing the key you just typed tells you nothing — even when the key is
    // the only prose-shaped column in the table.
    const t = table(col('id', { type: 'text' }), col('name'));
    expect(previewFieldOf(t)?.field).toBe('name');
  });

  it('falls back to the key column when it is the only one', () => {
    expect(previewFieldOf(table(col('id')))?.field).toBe('id');
  });

  it('is undefined for a table with no columns', () => {
    expect(previewFieldOf(table())).toBeUndefined();
  });
});

describe('planPreview', () => {
  const t = table(col('id'), col('name'), col('body', { renderer: 'markdown' }));

  it('reads a second target that names a column as the FIELD', () => {
    const plan = planPreview(t, ['name']);
    expect(plan).toEqual({ field: t.columns[1], keyFilter: {} });
  });

  it('reads a second target that names nothing as a KEY', () => {
    const plan = planPreview(t, ['n-17']);
    // Field chosen for you; the key matches against the first column.
    expect('error' in plan ? null : plan.field.field).toBe('body');
    expect('error' in plan ? null : plan.keyFilter).toEqual({ id: '=n-17' });
  });

  it('matches a key EXACTLY, so a prefix does not win the row', () => {
    // A bare value means "contains" to the filter language, and `n-1` would then
    // match `n-17`. A key is an identity, so it carries the `=`.
    const plan = planPreview(t, ['n-1']);
    expect('error' in plan ? null : plan.keyFilter).toEqual({ id: '=n-1' });
  });

  it('takes three targets as field then key, with no guessing', () => {
    const plan = planPreview(t, ['name', 'n-17']);
    expect('error' in plan ? null : plan.field.field).toBe('name');
    expect('error' in plan ? null : plan.keyFilter).toEqual({ id: '=n-17' });
  });

  it('lets the three-target form name a key that looks like a column', () => {
    // `preview/t/body` would read `body` as a field. The explicit form is how a
    // record whose id IS "body" is reached.
    const plan = planPreview(t, ['name', 'body']);
    expect('error' in plan ? null : plan.keyFilter).toEqual({ id: '=body' });
  });

  it('refuses an unknown field in the three-target form', () => {
    // Here there is no ambiguity to resolve — the user named a field, and it does
    // not exist — so guessing would only hide the typo.
    expect(planPreview(t, ['nope', 'n-17'])).toEqual({ error: '"nope" is not a column of this table.' });
  });

  it('refuses a table with no columns', () => {
    expect('error' in planPreview(table(), ['anything'])).toBe(true);
  });
});
