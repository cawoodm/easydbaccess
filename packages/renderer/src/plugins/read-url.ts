// packages/renderer/src/plugins/read-url.ts
//
// Read an already-fetched Response body to text, reporting byte progress when
// the size is known. Pure (no DOM, no fetch) so it stays unit-testable; the
// caller (import-data's fetchImportText) owns the fetch, the error handling and
// the size guard, and the UI wiring lives in ../chrome/top-progress.ts.

/**
 * Return an OK Response's body as text. Streams it and calls `onProgress` with a
 * 0..1 fraction while reading WHEN a `Content-Length` is present (a
 * CORS-safelisted header, so it's readable cross-origin); otherwise reads it in
 * one shot with no progress. Assumes the response is already checked for
 * `res.ok` and size limits by the caller.
 */
/**
 * Rewrite a known non-CORS "web" URL to a CORS-enabled equivalent so a browser
 * import can fetch it directly (no server proxy needed). Unknown URLs pass
 * through unchanged.
 *
 * Currently handles GitHub blob/raw page URLs:
 *   github.com/{owner}/{repo}/(blob|raw)/{ref}/{path…}
 *     → raw.githubusercontent.com/{owner}/{repo}/{ref}/{path…}
 * `raw.githubusercontent.com` sends `access-control-allow-origin: *`, whereas
 * `github.com` does not, so the web URL a user copies from the address bar (or
 * a "Raw" link, which points at `/raw/…`) otherwise fails CORS. A leading
 * `refs/heads/` or `refs/tags/` in the ref is collapsed to the plain
 * branch/tag name (both forms work on the raw host; this matches what users
 * expect to see). Path segments keep their original percent-encoding; any query
 * string / fragment is dropped (raw file URLs don't use them).
 */
export function toCorsFriendlyUrl(url: string): string {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return url;
  }
  const host = u.hostname.toLowerCase();
  if (host === 'github.com' || host === 'www.github.com') {
    const parts = u.pathname.split('/').filter(Boolean); // [owner, repo, blob|raw, ref, …path]
    if (parts.length >= 5 && (parts[2] === 'blob' || parts[2] === 'raw')) {
      const owner = parts[0]!;
      const repo = parts[1]!;
      let rest = parts.slice(3); // ref + path segments
      if (rest.length >= 3 && rest[0] === 'refs' && (rest[1] === 'heads' || rest[1] === 'tags')) {
        rest = rest.slice(2); // drop refs/heads | refs/tags
      }
      return `https://raw.githubusercontent.com/${[owner, repo, ...rest].join('/')}`;
    }
  }
  return url;
}

/**
 * True when `text` is a Git-LFS pointer file rather than the real content.
 *
 * `raw.githubusercontent.com` serves LFS-tracked files as their pointer — a
 * ~130-byte text stub — with HTTP 200 and no hint that it is not the data. An
 * import of that stub "succeeds" and produces one garbage row, so callers must
 * detect it and follow up on the media host (see {@link toGitLfsMediaUrl}).
 *
 * The pointer format is specified: a `version` line naming the spec URL, then
 * `oid` and `size` lines. Requiring all three keeps a real CSV/JSON whose first
 * line happens to mention git-lfs from being mistaken for a pointer.
 */
export function isGitLfsPointer(text: string): boolean {
  // A pointer file is tiny; anything large is the real content.
  if (text.length > 1024) return false;
  const lines = text.split('\n');
  return (
    lines[0]?.startsWith('version https://git-lfs.github.com/spec/v1') === true &&
    lines.some((l) => l.startsWith('oid ')) &&
    lines.some((l) => l.startsWith('size '))
  );
}

/**
 * The `media.githubusercontent.com` URL that serves a GitHub LFS file's real
 * bytes, or `null` when `url` is not a GitHub file URL.
 *
 * Accepts what a user pastes (`github.com/{owner}/{repo}/blob|raw/{ref}/{path}`)
 * as well as the already-rewritten raw host, because both map onto the same
 * media path:
 *   media.githubusercontent.com/media/{owner}/{repo}/{ref}/{path…}
 * The media host sends `access-control-allow-origin: *` and accepts either a
 * plain branch name or a `refs/heads/…` ref. It 404s for files that are NOT
 * LFS-tracked, so only reach for it once a pointer has actually come back.
 */
export function toGitLfsMediaUrl(url: string): string | null {
  const raw = toCorsFriendlyUrl(url);
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.hostname.toLowerCase() !== 'raw.githubusercontent.com') return null;
  const path = u.pathname.replace(/^\/+/, '');
  if (path.split('/').filter(Boolean).length < 4) return null; // owner/repo/ref/path
  return `https://media.githubusercontent.com/media/${path}`;
}

export async function readResponseText(
  res: Response,
  onProgress?: (fraction: number) => void,
): Promise<string> {
  const len = Number(res.headers?.get?.('content-length'));
  const reader = res.body?.getReader?.();
  if (reader && Number.isFinite(len) && len > 0) {
    const chunks: Uint8Array[] = [];
    let received = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        chunks.push(value);
        received += value.length;
        onProgress?.(Math.min(1, received / len));
      }
    }
    const merged = new Uint8Array(received);
    let offset = 0;
    for (const c of chunks) {
      merged.set(c, offset);
      offset += c.length;
    }
    return new TextDecoder().decode(merged);
  }
  return await res.text();
}
