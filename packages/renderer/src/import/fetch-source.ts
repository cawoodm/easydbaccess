// packages/renderer/src/import/fetch-source.ts
//
// The shared read layer for every importer. Moved out of the `import-data`
// plugin, where it was private, so that a format plugin does not have to
// re-invent the CORS rewrite, the size ceiling, the progress bar or the error
// messages. This is the `ctx.fetchText` the importer contract hands out.
//
// Behavior is unchanged from the version that lived in `import-data.ts`.

import type { HostApi } from '@easydb/shared';
// Type-only on purpose. `top-progress.js` registers a custom element at import
// time, which throws under a plain Node test environment. This module is
// imported by EVERY importer, so it must stay free of DOM side effects; the
// class is loaded lazily in `fetchImportTextWithBar` below. `json-import`
// already used this trick — keeping it here means each importer no longer has
// to remember it.
import type { ProgressHandle } from '../chrome/top-progress.js';
import { isGitLfsPointer, readResponseText, toCorsFriendlyUrl, toGitLfsMediaUrl } from '../plugins/read-url.js';

/**
 * Hard ceiling on a URL import buffered into the browser. A CSV/JSON body is
 * read fully into a string and parsed in memory (then written row-by-row to
 * IndexedDB), so a huge file OOMs or has the browser abort the transfer with an
 * opaque "Load failed" TypeError. We refuse up front with the real size so the
 * user gets an actionable reason instead of a bare failure.
 */
export const MAX_IMPORT_BYTES = 50 * 1024 * 1024; // 50 MB

/** URL host for messages, falling back to the raw URL if it doesn't parse. */
export function urlHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** Last path segment of a URL, used to name an imported table. */
export function filenameFromUrl(url: string): string {
  try {
    const path = new URL(url).pathname;
    const last = path.split('/').filter(Boolean).pop();
    return last && last.length > 0 ? last : 'sample.db.json';
  } catch {
    return 'sample.db.json';
  }
}

/** First ~300 chars of a response body, whitespace-collapsed, for error context. */
async function bodySnippet(res: Response): Promise<string> {
  try {
    const t = await res.text();
    return t.replace(/\s+/g, ' ').trim().slice(0, 300);
  } catch {
    return '';
  }
}

export interface ImportProgress {
  /** Fired once if the whole read (connect + body) exceeds `slowMs`. */
  onSlow?: () => void;
  /** Fired with a 0..1 fraction while the body streams (when the size is known). */
  onProgress?: (fraction: number) => void;
  /** Slow threshold before `onSlow` fires. Default 2000ms. */
  slowMs?: number;
  /**
   * Byte ceiling for this read. Defaults to {@link MAX_IMPORT_BYTES}; pass
   * `null` to lift it.
   *
   * The ceiling exists because a COPY buffers the whole body and then writes
   * every row to IndexedDB, so a huge file OOMs the tab. Two cases do not fit
   * that reasoning and must not be refused on total size:
   *   - a REFERENCE, which persists nothing (rows are re-fetched on demand),
   *   - a capped import, which keeps only the first `maxRows` rows.
   */
  maxBytes?: number | null;
}

/** Human size for a byte count, used in the over-the-limit message. */
function mb(bytes: number): string {
  // One decimal, but not a pointless one: the ceiling is a round 50 MB, and
  // "over the 50.0 MB limit" reads worse than "over the 50 MB limit".
  const n = bytes / (1024 * 1024);
  return `${Number.isInteger(n) ? n : n.toFixed(1)} MB`;
}

/**
 * Fetch a URL for import and return its text, ALWAYS throwing an informative
 * Error on failure — never a bare "Load failed"/"Failed to fetch". Distinguishes:
 *   - fetch rejection (no response: unreachable / CORS-blocked / transfer aborted),
 *   - HTTP error status (surfaces the code + a response-body snippet),
 *   - oversized payload (surfaces the actual Content-Length vs the limit),
 *   - body-read failure (huge/truncated response).
 */
export async function fetchImportText(api: HostApi, rawUrl: string, progress: ImportProgress = {}): Promise<string> {
  // Rewrite known non-CORS web URLs (e.g. a github.com blob/raw link) to their
  // CORS-enabled host so the browser can fetch them directly. No-op otherwise.
  const url = toCorsFriendlyUrl(rawUrl);
  // Slow-read timer spans the whole operation (a server slow to respond, or a
  // large body slow to transfer) so the bar can be revealed only past ~2s.
  const slowMs = progress.slowMs ?? 2000;
  let timer: ReturnType<typeof setTimeout> | undefined = setTimeout(() => {
    timer = undefined;
    progress.onSlow?.();
  }, slowMs);
  const stopTimer = (): void => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  };

  const ceiling = progress.maxBytes === null ? null : (progress.maxBytes ?? MAX_IMPORT_BYTES);

  // One guarded read: reach the host, check the status, enforce the size limit,
  // then stream the body. Factored out because an LFS pointer needs a second
  // read from the media host, which must pass the same guards.
  const readText = async (target: string): Promise<string> => {
    let res: Response;
    try {
      res = await api.backend.fetch(target);
    } catch (err) {
      throw new Error(
        `Could not reach ${urlHost(target)} — no response. The server may be down, ` +
          `blocking cross-origin (CORS) requests, or the transfer may have failed ` +
          `(e.g. a very large file). [${(err as Error).message}]`,
        { cause: err },
      );
    }
    if (!res.ok) {
      const snippet = await bodySnippet(res);
      throw new Error(`HTTP ${res.status} ${res.statusText || ''}`.trim() + (snippet ? ` — ${snippet}` : ''));
    }
    const len = Number(res.headers.get('content-length'));
    if (ceiling !== null && Number.isFinite(len) && len > ceiling) {
      // Rejecting the response does NOT stop the transfer — without this the
      // browser keeps streaming the whole oversized body in the background
      // (a 140 MB GitHub LFS file froze the tab for minutes after the error).
      void res.body?.cancel().catch(() => undefined);
      throw new Error(
        `Response is ${mb(len)}, over the ${mb(ceiling)} browser import limit. ` +
          `Set a row limit, import it as a Reference instead of a Copy, take a ` +
          `smaller extract, or connect to a server/Datasette for large datasets.`,
      );
    }
    try {
      return await readResponseText(res, progress.onProgress);
    } catch (err) {
      throw new Error(`Failed reading the response body from ${urlHost(target)}: ${(err as Error).message}`, { cause: err });
    }
  };

  try {
    const text = await readText(url);
    // GitHub serves LFS-tracked files as a pointer stub on the raw host, with
    // HTTP 200. Without this the import "succeeds" with one row of stub text.
    if (isGitLfsPointer(text)) {
      const media = toGitLfsMediaUrl(url);
      if (media) return await readText(media);
    }
    return text;
  } finally {
    stopTimer();
  }
}

/**
 * {@link fetchImportText} while showing the top progress bar — but only if the
 * read is slow (exceeds ~2s). The bar is determinate when the response
 * advertises a `Content-Length`, indeterminate otherwise, so quick imports
 * never flash it.
 */
export async function fetchImportTextWithBar(api: HostApi, url: string, label: string, opts: { maxBytes?: number | null } = {}): Promise<string> {
  // Resolve the bar class before the read starts, so the `onSlow` callback
  // (which must stay synchronous) has it to hand.
  const { TopProgress } = await import('../chrome/top-progress.js');
  // Held on an object so the closure assignment isn't narrowed away in finally.
  const ref: { handle: ProgressHandle | null } = { handle: null };
  try {
    return await fetchImportText(api, url, {
      onSlow: () => {
        ref.handle = TopProgress.begin(label);
      },
      onProgress: (f) => ref.handle?.fraction(f),
      ...(opts.maxBytes !== undefined ? { maxBytes: opts.maxBytes } : {}),
    });
  } finally {
    ref.handle?.done();
  }
}
