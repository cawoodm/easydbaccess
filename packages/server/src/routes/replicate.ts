import type { Hono } from 'hono';
import type { ServerDeps } from '../index.js';

/**
 * RxDB HTTP replication endpoints. Placeholder until the storage layer is wired.
 *
 * The real implementation will expose:
 *   POST /replicate/:collection/pull  — { checkpoint, batchSize } -> { documents, checkpoint }
 *   POST /replicate/:collection/push  — { changeRows } -> { conflicts }
 *   GET  /replicate/:collection/stream — SSE/WebSocket for live changes
 *
 * See https://rxdb.info/replication.html for the contract.
 */
export function mountReplicate(app: Hono, _deps: ServerDeps) {
  app.post('/replicate/:collection/pull', (c) => {
    return c.json({ documents: [], checkpoint: null, todo: 'replicate-pull' }, 501);
  });

  app.post('/replicate/:collection/push', (c) => {
    return c.json({ conflicts: [], todo: 'replicate-push' }, 501);
  });
}
