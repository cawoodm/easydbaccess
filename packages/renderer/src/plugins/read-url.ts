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
