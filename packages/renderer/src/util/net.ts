// packages/renderer/src/util/net.ts
//
// One place that answers "the network did not work, now what".
//
// Three rules, in order of how much they matter:
//
//  1. **A timeout is the guarantee.** A bare `fetch` never gives up. On a
//     captive portal or a black-holed DNS it stays pending forever, and
//     anything awaiting it stays pending too. `app-context.ts` awaits the
//     plugin loader on the critical boot path, so ONE hanging fetch used to
//     mean an empty shell with no tables, no error and no way out. Every
//     bounded request in this app goes through `fetchWithTimeout`.
//
//  2. **`navigator.onLine` is only a hint.** `true` means "there is a network
//     interface", not "the internet is reachable" — a captive portal reports
//     online. So `isOffline()` may be used to SKIP work that certainly cannot
//     succeed, and to word a message better, but never as the only protection.
//     Rule 1 is what actually holds. `false`, on the other hand, is reliable.
//
//  3. **Say "offline", not "Failed to fetch".** `describeNetworkError` is the
//     wording used everywhere, so the user reads one explanation instead of
//     the browser's. The shape is the one already proven in
//     `import/fetch-source.ts`.
//
// Deliberately NOT applied to `api.backend.fetch` (`plugin-host/api-factory.ts`).
// Imports pull multi-hundred-megabyte files through that chokepoint, and a
// blanket deadline would break them. Its callers own their own deadlines.

/** Default deadline for a small request (a plugin body, a catalog, a sync round-trip). */
export const NET_TIMEOUT_MS = 8_000;

/**
 * `fetch`, but it gives up.
 *
 * A caller's own `signal` still works: both are combined, so whichever fires
 * first aborts the request. `AbortSignal.timeout` reports a `TimeoutError`,
 * a caller abort reports an `AbortError` — `isNetworkFailure` accepts both.
 */
export function fetchWithTimeout(input: RequestInfo | URL, init: RequestInit = {}, ms: number = NET_TIMEOUT_MS): Promise<Response> {
  const deadline = AbortSignal.timeout(ms);
  const signal = init.signal ? AbortSignal.any([init.signal, deadline]) : deadline;
  return fetch(input, { ...init, signal });
}

/**
 * Is this device certainly offline?
 *
 * Only ever `true` when the browser is sure. See rule 2 above: use it to skip
 * doomed work and to word a message, never instead of a timeout.
 */
export function isOffline(): boolean {
  return typeof navigator !== 'undefined' && navigator.onLine === false;
}

/**
 * Did this failure come from the network rather than from the server or our
 * own code?
 *
 * `fetch` rejects with a bare `TypeError` for every transport failure — DNS,
 * refused connection, CORS, offline — and there is no richer signal to read.
 * An HTTP error is NOT one of these: a 404 resolves normally and the caller
 * throws its own `Error`, which must stay distinguishable so a broken plugin
 * URL still reports itself.
 */
export function isNetworkFailure(err: unknown): boolean {
  if (err instanceof DOMException) return err.name === 'AbortError' || err.name === 'TimeoutError';
  if (err instanceof TypeError) return true;
  // Some runtimes surface an abort as a plain Error carrying the name.
  const name = (err as { name?: unknown } | null)?.name;
  return name === 'AbortError' || name === 'TimeoutError';
}

/**
 * The message to show the user for a failed request.
 *
 * Leads with the offline fact when the browser is sure of it, because that one
 * sentence explains every other failure on screen at the same moment.
 */
export function describeNetworkError(err: unknown, url?: string): string {
  const where = url ? ` (${url})` : '';
  if (isOffline()) return `You appear to be offline — could not reach the network${where}. Your data is local and still fully editable.`;
  if (err instanceof DOMException && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
    return `Timed out after ${Math.round(NET_TIMEOUT_MS / 1000)}s${where}. The host may be unreachable or blocked.`;
  }
  if (err instanceof TypeError) return `Could not reach${where || ' the host'} — check the URL, your connection, or the host's CORS policy.`;
  return (err as Error)?.message ?? String(err);
}

/**
 * Call `cb` whenever the browser's idea of connectivity flips. Returns the
 * unsubscribe function, so a Lit element can drop it in `disconnectedCallback`.
 */
export function onOnlineChange(cb: (online: boolean) => void): () => void {
  // Not every runtime this module is imported into is a browser — the unit
  // suites run under plain Node, where there is nothing to listen to and
  // nothing to report. Subscribing to nothing is the honest answer there.
  const target = globalThis as Partial<EventTarget>;
  if (typeof target.addEventListener !== 'function' || typeof target.removeEventListener !== 'function') {
    return () => undefined;
  }
  const on = (): void => cb(true);
  const off = (): void => cb(false);
  target.addEventListener('online', on);
  target.addEventListener('offline', off);
  return () => {
    target.removeEventListener?.('online', on);
    target.removeEventListener?.('offline', off);
  };
}
