import { beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetPaneActions, paneActionsAvailable, paneFilter, paneSort, providePaneActions } from '../../../packages/renderer/src/table/pane-actions.js';

/** A host that records what it was asked for. */
function spyHost() {
  return { filter: vi.fn(), sort: vi.fn() };
}

beforeEach(() => __resetPaneActions());

describe('paneFilter / paneSort', () => {
  it('reaches the host registered for the key', () => {
    const host = spyHost();
    providePaneActions('t1', host);

    expect(paneFilter('t1', 'country', 'CH')).toBe(true);
    expect(host.filter).toHaveBeenCalledWith('country', 'CH');

    expect(paneSort('t1', 'amount', true)).toBe(true);
    expect(host.sort).toHaveBeenCalledWith('amount', true);
  });

  it('sorts non-additively by default — one click replaces the sort', () => {
    const host = spyHost();
    providePaneActions('t1', host);
    paneSort('t1', 'amount');
    expect(host.sort).toHaveBeenCalledWith('amount', false);
  });

  it('answers false when nothing hosts the key', () => {
    // A windowed visualization, or a pane whose host is minimized. The caller
    // filters its own rows instead, so this has to be reported, not thrown.
    expect(paneFilter('nobody', 'country', 'CH')).toBe(false);
    expect(paneSort('nobody', 'country')).toBe(false);
  });

  it('answers false for an empty key rather than matching one', () => {
    providePaneActions('', spyHost());
    expect(paneFilter('', 'country', 'CH')).toBe(false);
  });

  it('keys hosts apart, so one grid cannot answer for another', () => {
    const a = spyHost();
    const b = spyHost();
    providePaneActions('t1', a);
    providePaneActions('t2', b);

    paneFilter('t2', 'country', 'DE');
    expect(a.filter).not.toHaveBeenCalled();
    expect(b.filter).toHaveBeenCalledWith('country', 'DE');
  });

  it('lets the newest registration win, and its release does not orphan it', () => {
    // A grid re-registers on every repoint; the release returned by the OLD
    // registration must not delete the new one.
    const first = spyHost();
    const second = spyHost();
    const releaseFirst = providePaneActions('t1', first);
    providePaneActions('t1', second);
    releaseFirst();

    expect(paneFilter('t1', 'country', 'CH')).toBe(true);
    expect(second.filter).toHaveBeenCalled();
    expect(first.filter).not.toHaveBeenCalled();
  });

  it('stops answering once released', () => {
    const host = spyHost();
    const release = providePaneActions('t1', host);
    release();
    expect(paneFilter('t1', 'country', 'CH')).toBe(false);
    expect(host.filter).not.toHaveBeenCalled();
  });

  it('survives a host that throws, reporting it as unhandled', () => {
    // A broken visualization host must not take the pane's click handler down.
    const host = {
      filter: vi.fn(() => {
        throw new Error('boom');
      }),
      sort: vi.fn(),
    };
    providePaneActions('t1', host);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(paneFilter('t1', 'country', 'CH')).toBe(false);
    warn.mockRestore();
  });
});

describe('paneActionsAvailable', () => {
  it('says whether a pane could act on this key', () => {
    expect(paneActionsAvailable('t1')).toBe(false);
    const release = providePaneActions('t1', spyHost());
    expect(paneActionsAvailable('t1')).toBe(true);
    release();
    expect(paneActionsAvailable('t1')).toBe(false);
  });
});
