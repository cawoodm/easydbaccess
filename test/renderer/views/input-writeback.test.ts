import { describe, expect, it } from 'vitest';
import type { ColumnSpec, Row } from '@easydb/shared';
import { mayWrite, patchFor } from '../../../packages/renderer/src/views/input-writeback.js';

/**
 * What an `$input.FIELD` control is allowed to write.
 *
 * **The rules are the grid's**, lifted out of `view-window.ts` so a record pane
 * and a view template answer the same question the same way. A value a user
 * cannot type into a cell must not be writable through a template either, or the
 * template becomes a way round the column's own constraints — which is the
 * failure this suite exists to keep out.
 */

const col = (field: string, over: Partial<ColumnSpec> = {}): ColumnSpec => ({ field, label: field, type: 'string', ...over }) as ColumnSpec;

const row: Row = { id: 'r1', tableId: 't1', updatedAt: 0, data: { title: 'Berlin', n: 3 } };

const edit = (field: string, value: unknown) => ({ rowId: 'r1', field, value });

describe('the four refusals', () => {
  it('refuses a read-only view', () => {
    const v = mayWrite(edit('title', 'x'), col('title'), row, { readonly: true });
    expect(v).toEqual({ ok: false, reason: 'This view is read-only.' });
  });

  it('refuses a read-only table, whatever the template offered', () => {
    const v = mayWrite(edit('title', 'x'), col('title'), row, { tableReadonly: true });
    expect(v).toEqual({ ok: false, reason: 'This table is read-only.' });
  });

  it('refuses a read-only column', () => {
    const v = mayWrite(edit('title', 'x'), col('title', { readonly: true }), row, {});
    expect(v.ok).toBe(false);
    expect(v.ok === false && v.reason).toContain('read-only');
  });

  it('refuses a column computed by its script — there is nowhere to write back to', () => {
    const scripted = col('total', { script: 'return 1', scriptEnabled: true } as Partial<ColumnSpec>);
    const v = mayWrite(edit('total', 5), scripted, row, {});
    expect(v.ok).toBe(false);
    expect(v.ok === false && v.reason).toContain('column script');
  });

  it("passes the column's own rules through, in the column's own words", () => {
    const v = mayWrite(edit('title', ''), col('title', { notnull: true }), row, {});
    // `validateValue`'s sentence, unchanged — one rule reads one way everywhere.
    expect(v).toEqual({ ok: false, reason: 'title cannot be empty.' });
  });
});

describe('what it lets through', () => {
  it('allows an ordinary edit', () => {
    expect(mayWrite(edit('title', 'Bern'), col('title'), row, {})).toEqual({ ok: true });
  });

  it('allows a value that would only fail a unique check it cannot run', () => {
    // A record pane holds one row, so `unique` cannot see a duplicate. Saying so
    // is better than pretending — see `validate-value.ts`.
    const v = mayWrite(edit('title', 'Berlin'), col('title', { unique: true }), row, {});
    expect(v).toEqual({ ok: true });
  });

  it('catches a duplicate when the caller DID hand over the rows', () => {
    const other: Row = { id: 'r2', tableId: 't1', updatedAt: 0, data: { title: 'Bern' } };
    const v = mayWrite(edit('title', 'Bern'), col('title', { unique: true }), row, { allRows: [row, other] });
    expect(v.ok).toBe(false);
    expect(v.ok === false && v.reason).toContain('must be unique');
  });
});

describe('the things that are not there', () => {
  it('refuses a token naming no column', () => {
    const v = mayWrite(edit('nosuch', 'x'), undefined, row, {});
    expect(v.ok).toBe(false);
    expect(v.ok === false && v.reason).toContain('nosuch');
  });

  it('refuses when the record has gone', () => {
    // Deleted from another window while its card was on screen.
    const v = mayWrite(edit('title', 'x'), col('title'), undefined, {});
    expect(v).toEqual({ ok: false, reason: 'That record is no longer here.' });
  });
});

describe('patchFor', () => {
  it('writes the whole row back with one field changed', () => {
    // The store's `patch` replaces `data` wholesale, so a single-key object
    // would drop every other field — which is why the view window has always
    // spread the existing data.
    const patch = patchFor(edit('title', 'Bern'), row);
    expect(patch.data).toEqual({ title: 'Bern', n: 3 });
    expect(typeof patch.updatedAt).toBe('number');
  });

  it('does not mutate the row it was given', () => {
    patchFor(edit('title', 'Bern'), row);
    expect(row.data['title']).toBe('Berlin');
  });
});
