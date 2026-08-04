import { describe, expect, it } from 'vitest';
import { ImportProgress } from '../../../packages/renderer/src/plugins/import-progress.js';

/**
 * The bar exists to be HONEST about how far through a file the import is, so what
 * these tests check is the weighting — a bar that gives a 12-row table the same
 * share as a 609,283-row one is worse than none, because it invites the user to
 * conclude the app has hung.
 */

/** Northwind's real shape: three enormous tables among a dozen small ones. */
const NORTHWIND = [
  { tableId: 'orderdetails', total: 609283 },
  { tableId: 'orders', total: 609283 },
  { tableId: 'invoices', total: 609283 },
  { tableId: 'customers', total: 93 },
  { tableId: 'employees', total: 9 },
];

describe('ImportProgress', () => {
  it('weights each table by its rows, not by being a table', () => {
    const p = new ImportProgress(NORTHWIND);
    // Both small tables done: two of five tables, but almost none of the work.
    p.complete('customers');
    p.complete('employees');
    expect(p.completedTables()).toBe(2);
    expect(p.fraction()).toBeLessThan(0.001);
    // One big table done: one of five tables, but a third of the work.
    p.complete('orders');
    expect(p.fraction()).toBeGreaterThan(0.33);
    expect(p.fraction()).toBeLessThan(0.34);
  });

  it('advances within a table as its rows arrive', () => {
    const p = new ImportProgress([{ tableId: 't', total: 1000 }]);
    expect(p.fraction()).toBe(0);
    p.observe('t', 250);
    expect(p.fraction()).toBe(0.25);
    p.observe('t', 1000);
    expect(p.fraction()).toBe(1);
  });

  it('reaches exactly 1 when every table completes', () => {
    const p = new ImportProgress(NORTHWIND);
    for (const i of NORTHWIND) p.complete(i.tableId);
    expect(p.fraction()).toBe(1);
    expect(p.completedTables()).toBe(5);
  });

  it('cannot be pushed past 1 by a table reporting more rows than planned', () => {
    // A planned total is a snapshot from a separate COUNT, and an append writes
    // into a table that already held rows, so an overshoot is normal.
    const p = new ImportProgress([{ tableId: 't', total: 100 }]);
    p.observe('t', 5000);
    expect(p.fraction()).toBe(1);
  });

  it('completes a table that reported FEWER rows than planned', () => {
    // Otherwise a stale count leaves the bar stuck short of 100% for the rest of
    // the run, which reads as "still working" long after it stopped.
    const p = new ImportProgress([
      { tableId: 'a', total: 1000 },
      { tableId: 'b', total: 1000 },
    ]);
    p.observe('a', 400);
    p.complete('a');
    p.complete('b');
    expect(p.fraction()).toBe(1);
  });

  it('falls back to one-per-table when no row count is known', () => {
    // Views are never counted (running one is the expensive thing), so a plan of
    // only views declares nothing. Weighing by zero would pin the bar at 0% for
    // the whole run and then jump.
    const p = new ImportProgress([
      { tableId: 'v1', total: -1 },
      { tableId: 'v2', total: -1 },
      { tableId: 'v3', total: -1 },
    ]);
    expect(p.fraction()).toBe(0);
    p.complete('v1');
    expect(p.fraction()).toBeCloseTo(1 / 3, 5);
    p.complete('v2');
    p.complete('v3');
    expect(p.fraction()).toBe(1);
  });

  it('treats an uncounted table as weightless when others do declare rows', () => {
    // Mixed plan: the counted tables are what the time goes on, so they get all
    // the weight and the view rides along.
    const p = new ImportProgress([
      { tableId: 't', total: 100 },
      { tableId: 'v', total: -1 },
    ]);
    p.complete('t');
    expect(p.fraction()).toBe(1);
  });

  it('is complete for an empty plan rather than dividing by zero', () => {
    const p = new ImportProgress([]);
    expect(p.fraction()).toBe(1);
    expect(p.tableCount).toBe(0);
  });

  it('ignores progress for a table that is not in the plan', () => {
    const p = new ImportProgress([{ tableId: 't', total: 10 }]);
    p.observe('somewhere-else', 10);
    p.complete('somewhere-else');
    expect(p.fraction()).toBe(0);
    expect(p.completedTables()).toBe(0);
  });

  it('handles a plan of empty tables without stalling', () => {
    // Every table has 0 rows, so nothing can be weighed — one-per-table again.
    const p = new ImportProgress([
      { tableId: 'a', total: 0 },
      { tableId: 'b', total: 0 },
    ]);
    p.complete('a');
    expect(p.fraction()).toBe(0.5);
  });
});
