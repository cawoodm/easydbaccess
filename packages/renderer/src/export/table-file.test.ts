import { describe, it, expect } from 'vitest';
import type { ColumnSpec, Row, Table } from '@easydb/shared';
import { scopedColumns, scopedRows, scopedTable, tableToFile } from './table-file.js';

function col(field: string, extra: Partial<ColumnSpec> = {}): ColumnSpec {
  return { field, label: field, type: 'string', ...extra };
}

function row(data: Record<string, unknown>): Row {
  return { id: `r-${JSON.stringify(data)}`, tableId: 't', data, updatedAt: 0 };
}

function table(extra: Partial<Table> = {}): Table {
  return {
    id: 't1',
    workspaceId: 'ws',
    name: 'Widgets',
    code: 'widgets',
    columns: [col('name'), col('secret', { hidden: true }), col('qty')],
    view: 'table',
    updatedAt: 0,
    ...extra,
  };
}

describe('scopedColumns / scopedTable', () => {
  it('raw scope keeps every column, including hidden ones', () => {
    const t = table();
    expect(scopedColumns(t, 'raw')).toEqual(t.columns);
    expect(scopedTable(t, 'raw')).toBe(t); // no copy needed for raw
  });

  it('visible scope drops hidden columns but preserves order of the rest', () => {
    const t = table();
    const cols = scopedColumns(t, 'visible');
    expect(cols.map((c) => c.field)).toEqual(['name', 'qty']);
  });

  it('visible scope returns a new table object with narrowed columns, other fields untouched', () => {
    const t = table({ sortColumn: 'qty', sortAsc: false, filters: { name: 'wid' } });
    const narrowed = scopedTable(t, 'visible');
    expect(narrowed).not.toBe(t);
    expect(narrowed.columns.map((c) => c.field)).toEqual(['name', 'qty']);
    expect(narrowed.sortColumn).toBe('qty');
    expect(narrowed.sortAsc).toBe(false);
    expect(narrowed.filters).toEqual({ name: 'wid' });
  });
});

describe('scopedRows', () => {
  const rows = [
    row({ name: 'Bolt', qty: 5 }),
    row({ name: 'Anchor', qty: 20 }),
    row({ name: 'Widget', qty: 1 }),
  ];

  it('raw scope returns every row, unsorted and unfiltered', () => {
    expect(scopedRows(table(), rows, 'raw')).toEqual(rows);
  });

  it('visible scope applies the table\'s filters', () => {
    const t = table({ filters: { name: 'an' } }); // substring "an" -> only "Anchor"
    const out = scopedRows(t, rows, 'visible');
    expect(out.map((r) => r.data.name)).toEqual(['Anchor']);
  });

  it('visible scope applies the table\'s sort', () => {
    const t = table({ sortColumn: 'qty', sortAsc: true });
    const out = scopedRows(t, rows, 'visible');
    expect(out.map((r) => r.data.qty)).toEqual([1, 5, 20]);
  });

  it('visible scope combines filter + sort', () => {
    const t = table({ filters: { qty: '!1' }, sortColumn: 'qty', sortAsc: false });
    // Excludes qty===1 (Widget); remaining sorted descending by qty.
    const out = scopedRows(t, rows, 'visible');
    expect(out.map((r) => r.data.name)).toEqual(['Anchor', 'Bolt']);
  });
});

describe('tableToFile', () => {
  it('projects rows onto the given columns and carries display/query state', () => {
    const t = table({ sortColumn: 'qty', sortAsc: true, filters: { name: 'a' }, title: 'Widgets!' });
    const rows = [row({ name: 'Bolt', qty: 5, secret: 'x' })];
    const file = tableToFile(t, rows);
    expect(file.name).toBe('Widgets');
    expect(file.title).toBe('Widgets!');
    expect(file.sortColumn).toBe('qty');
    expect(file.filters).toEqual({ name: 'a' });
    expect(file.rows).toEqual([{ name: 'Bolt', secret: 'x', qty: 5 }]);
  });

  it('a hidden column excluded from the scope is absent from the projected rows', () => {
    const t = scopedTable(table(), 'visible'); // drops 'secret'
    const rows = [row({ name: 'Bolt', qty: 5, secret: 'x' })];
    const file = tableToFile(t, rows);
    expect(file.columns.map((c) => c.field)).toEqual(['name', 'qty']);
    expect(file.rows).toEqual([{ name: 'Bolt', qty: 5 }]);
  });

  it('a remote table (source != null) yields no rows regardless of what is passed in', () => {
    const t = table({ source: { type: 'datasette', config: {} } });
    const rows = [row({ name: 'Bolt', qty: 5 })];
    const file = tableToFile(t, rows);
    expect(file.rows).toEqual([]);
    // Definition still travels — this is a reconnect descriptor, not data loss.
    expect(file.columns).toEqual(t.columns);
    expect(file.source).toEqual(t.source);
  });
});
