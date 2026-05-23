/**
 * Tiny stdout logger used by routes. Prefixes a `[tag]` for greppability and
 * elides when EASYDB_LOG=quiet (set by the test runner).
 *
 *   log('sync', 'pull', { workspaceId: 'w1', etag: 'abc' });
 *   -> [sync] pull workspaceId=w1 etag=abc
 */
export function log(tag: string, msg: string, fields?: Record<string, unknown>): void {
  if (process.env.EASYDB_LOG === 'quiet') return;
  const suffix = fields ? ' ' + formatFields(fields) : '';
  // eslint-disable-next-line no-console
  console.log(`[${tag}] ${msg}${suffix}`);
}

function formatFields(fields: Record<string, unknown>): string {
  return Object.entries(fields)
    .map(([k, v]) => `${k}=${formatValue(v)}`)
    .join(' ');
}

function formatValue(v: unknown): string {
  if (v === null) return 'null';
  if (v === undefined) return 'undefined';
  if (typeof v === 'string') return v.includes(' ') ? JSON.stringify(v) : v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}
