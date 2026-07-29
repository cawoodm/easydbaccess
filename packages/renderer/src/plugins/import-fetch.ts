// packages/renderer/src/plugins/import-fetch.ts
//
// Fetching a URL for import: the size ceiling, the informative error wrapping,
// and the GitHub LFS follow-up. Split out of import-data.ts because that module
// pulls in the plugin loader (and therefore custom elements), which makes it
// unloadable in a DOM-free unit test. Nothing here touches the DOM.

import type { HostApi } from '@easydb/shared';
import {
  isGitLfsPointer,
  readResponseText,
  toCorsFriendlyUrl,
  toGitLfsMediaUrl,
} from './read-url.js';

/**
 * Hard ceiling on a URL import buffered into the browser. A CSV/JSON body is
 * read fully into a string and parsed in memory (then written row-by-row to
 * IndexedDB), so a huge file OOMs or has the browser abort the transfer with an
 * opaque "Load failed" TypeError. We refuse up front with the real size so the
 * user gets an actionable reason instead of a bare failure.
 */
export const MAX_IMPORT_BYTES = 50 * 1024 * 1024; // 50 MB

/** URL host for messages, falling back to the raw URL if it doesn't parse. */
function urlHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
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

/**
 * Fetch a URL for import and return its text, ALWAYS throwing an informative
 * Error on failure — never a bare "Load failed"/"Failed to fetch". Distinguishes:
 *   - fetch rejection (no response: unreachable / CORS-blocked / transfer aborted),
 *   - HTTP error status (surfaces the code + a response-body snippet),
 *   - oversized payload (surfaces the actual Content-Length vs the limit),
 *   - body-read failure (huge/truncated response).
 */
export interface ImportProgress {
  /** Fired once if the whole read (connect + body) exceeds `slowMs`. */
  onSlow?: () => void;
  /** Fired with a 0..1 fraction while the body streams (when the size is known). */
  onProgress?: (fraction: number) => void;
  /** Slow threshold before `onSlow` fires. Default 2000ms. */
  slowMs?: number;
}

export async function fetchImportText(
  api: HostApi,
  rawUrl: string,
  progress: ImportProgress = {},
): Promise<string> {
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
      );
    }
    if (!res.ok) {
      const snippet = await bodySnippet(res);
      throw new Error(
        `HTTP ${res.status} ${res.statusText || ''}`.trim() + (snippet ? ` — ${snippet}` : ''),
      );
    }
    const len = Number(res.headers.get('content-length'));
    if (Number.isFinite(len) && len > MAX_IMPORT_BYTES) {
      // Rejecting the response does NOT stop the transfer — without this the
      // browser keeps streaming the whole oversized body in the background
      // (a 140 MB GitHub LFS file froze the tab for minutes after the error).
      void res.body?.cancel().catch(() => undefined);
      throw new Error(
        `Response is ${(len / (1024 * 1024)).toFixed(1)} MB, over the ` +
          `${MAX_IMPORT_BYTES / (1024 * 1024)} MB browser import limit. Import a smaller ` +
          `extract, or use a server/Datasette connection for large datasets.`,
      );
    }
    try {
      return await readResponseText(res, progress.onProgress);
    } catch (err) {
      throw new Error(
        `Failed reading the response body from ${urlHost(target)}: ${(err as Error).message}`,
      );
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
