import { afterEach, describe, expect, it, vi } from 'vitest';
import { NET_TIMEOUT_MS, describeNetworkError, fetchWithTimeout, isNetworkFailure, isOffline, onOnlineChange } from '../../../packages/renderer/src/util/net.js';

/**
 * The offline contract.
 *
 * Two rules carry the whole thing, and each has a test here that fails loudly
 * if it is ever weakened:
 *
 *  - A request must give up. `app-context.ts` awaits the plugin loader on the
 *    critical boot path, so one request that never settles used to mean an app
 *    with no tables, no error and no way out.
 *  - A transport failure must stay distinguishable from an HTTP failure. Boot
 *    suppresses the toast for the first and keeps it for the second, so a
 *    genuinely broken plugin still reports itself while an offline boot stays
 *    quiet.
 */

/** Replace `navigator.onLine` for one test. Restored in `afterEach`. */
function setOnline(value: boolean): void {
  Object.defineProperty(globalThis.navigator, 'onLine', { value, configurable: true });
}

afterEach(() => {
  setOnline(true);
  vi.unstubAllGlobals();
});

describe('fetchWithTimeout', () => {
  it('rejects a request that never settles', async () => {
    vi.stubGlobal('fetch', (_input: unknown, init?: RequestInit) => {
      // A black-holed host: connected, and then nothing. The only way out is
      // the abort signal.
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
      });
    });

    const err = await fetchWithTimeout('https://example.invalid/x', {}, 20).catch((e: unknown) => e);
    expect(isNetworkFailure(err)).toBe(true);
  });

  it('still honours the caller’s own signal', async () => {
    vi.stubGlobal('fetch', (_input: unknown, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
      });
    });

    const caller = new AbortController();
    // A long deadline, so only the caller's abort can end this.
    const pending = fetchWithTimeout('https://example.invalid/x', { signal: caller.signal }, 60_000);
    caller.abort();
    await expect(pending).rejects.toBeDefined();
  });

  it('passes a normal response straight through', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(new Response('hello')));
    const res = await fetchWithTimeout('https://example.test/x');
    expect(await res.text()).toBe('hello');
  });
});

describe('isNetworkFailure', () => {
  it('accepts what fetch throws for a transport failure', () => {
    expect(isNetworkFailure(new TypeError('Failed to fetch'))).toBe(true);
  });

  it('accepts an abort and a timeout', () => {
    expect(isNetworkFailure(new DOMException('aborted', 'AbortError'))).toBe(true);
    expect(isNetworkFailure(new DOMException('timed out', 'TimeoutError'))).toBe(true);
  });

  it('rejects an HTTP error — the boot toast must still fire for those', () => {
    expect(isNetworkFailure(new Error('HTTP 404 Not Found'))).toBe(false);
    expect(isNetworkFailure(new SyntaxError('Unexpected token <'))).toBe(false);
  });
});

describe('describeNetworkError', () => {
  it('leads with the offline fact when the browser is sure', () => {
    setOnline(false);
    expect(describeNetworkError(new TypeError('Failed to fetch'), 'https://x.test')).toMatch(/offline/i);
  });

  it('names the timeout when a request was cut off', () => {
    expect(describeNetworkError(new DOMException('t', 'TimeoutError'))).toContain(`${NET_TIMEOUT_MS / 1000}s`);
  });

  it('never leaks the browser’s bare wording for a transport failure', () => {
    const msg = describeNetworkError(new TypeError('Failed to fetch'), 'https://x.test');
    expect(msg).not.toBe('Failed to fetch');
    expect(msg).toContain('https://x.test');
  });

  it('passes a non-network error through unchanged', () => {
    expect(describeNetworkError(new Error('HTTP 500'))).toBe('HTTP 500');
  });
});

describe('isOffline', () => {
  it('is only true when the browser says so', () => {
    expect(isOffline()).toBe(false);
    setOnline(false);
    expect(isOffline()).toBe(true);
  });
});

describe('onOnlineChange', () => {
  it('reports both directions and unsubscribes', () => {
    // Plain Node has no `online`/`offline` events, so the listener target is
    // stood up here rather than assumed — the shape under test is the
    // subscribe/report/unsubscribe contract, not the browser's event plumbing.
    const bus = new EventTarget();
    const original = Object.getOwnPropertyDescriptor(globalThis, 'addEventListener');
    vi.stubGlobal('addEventListener', bus.addEventListener.bind(bus));
    vi.stubGlobal('removeEventListener', bus.removeEventListener.bind(bus));

    const seen: boolean[] = [];
    const off = onOnlineChange((online) => seen.push(online));
    bus.dispatchEvent(new Event('offline'));
    bus.dispatchEvent(new Event('online'));
    off();
    bus.dispatchEvent(new Event('offline'));
    expect(seen).toEqual([false, true]);

    if (!original) vi.unstubAllGlobals();
  });

  it('is a no-op where there is nothing to listen to', () => {
    vi.stubGlobal('addEventListener', undefined);
    expect(() => onOnlineChange(() => undefined)()).not.toThrow();
  });
});
