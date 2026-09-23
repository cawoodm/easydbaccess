import { beforeEach, describe, expect, it } from 'vitest';
import { __resetRunActions, registerRunAction, runActionsFor } from '../../../packages/renderer/src/table/run-actions.js';
import type { HostApi, Table } from '../../../packages/shared/src/index.js';

/**
 * The list behind the footer's ▶ **Run** menu.
 *
 * It is a registry rather than a fixed pair because each half — the column
 * script runner and Validate — is a separately toggleable plugin: switching one
 * off in the Plugin Manager has to take its item off the menu, not leave one
 * that answers nothing.
 */

const api = {} as HostApi;
const table = (over: Partial<Table> = {}): Table => ({ id: 't', name: 'T', columns: [], updatedAt: 0, ...over }) as Table;

const noop = async () => {};

beforeEach(() => __resetRunActions());

describe('runActionsFor', () => {
  it('is empty before anything registers, so the button can say so', () => {
    expect(runActionsFor(table())).toEqual([]);
  });

  it('orders by `order`, keeping registration order for ties', () => {
    registerRunAction({ id: 'b', label: 'B', order: 20, run: noop });
    registerRunAction({ id: 'a', label: 'A', order: 10, run: noop });
    registerRunAction({ id: 'c', label: 'C', order: 10, run: noop });
    expect(runActionsFor(table()).map((x) => x.id)).toEqual(['a', 'c', 'b']);
  });

  it('hides an action the table cannot take', () => {
    registerRunAction({ id: 'write', label: 'Write', available: (t) => !t.readonly, run: noop });
    registerRunAction({ id: 'read', label: 'Read', run: noop });
    expect(runActionsFor(table({ readonly: true })).map((x) => x.id)).toEqual(['read']);
    expect(runActionsFor(table()).map((x) => x.id)).toEqual(['write', 'read']);
  });

  it('replaces an action registered twice under one id, rather than listing it twice', () => {
    // A plugin re-`init`ed by a hot install must not double the menu.
    registerRunAction({ id: 'x', label: 'First', run: noop });
    registerRunAction({ id: 'x', label: 'Second', run: noop });
    expect(runActionsFor(table()).map((a) => a.label)).toEqual(['Second']);
  });

  it('removes what the remover was given, and nothing else', () => {
    const off = registerRunAction({ id: 'a', label: 'A', run: noop });
    registerRunAction({ id: 'b', label: 'B', run: noop });
    off();
    expect(runActionsFor(table()).map((x) => x.id)).toEqual(['b']);
  });
});

describe('a registered action', () => {
  it('is handed the api and the table it was picked for', async () => {
    const seen: Array<{ api: HostApi; table: Table }> = [];
    registerRunAction({
      id: 'a',
      label: 'A',
      run: async (a, t) => {
        seen.push({ api: a, table: t });
      },
    });
    const t = table({ id: 'pets' });
    await runActionsFor(t)[0]!.run(api, t);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.table.id).toBe('pets');
    expect(seen[0]!.api).toBe(api);
  });
});
