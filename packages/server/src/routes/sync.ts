import type { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { log } from '../log.js';
import type { Json, StoreAdapter } from '../storage/types.js';

/**
 * Whole-workspace JSON push/pull.
 *
 *   GET  /sync                       — list known workspaces (if the adapter supports it)
 *   GET  /sync/:workspaceId          — pull the workspace JSON; 404 if unwritten
 *   PUT  /sync/:workspaceId          — push (JSON body). If-Match enforces optimistic concurrency.
 *   GET  /sync/:workspaceId/stream   — SSE: { event: change, data: {"etag":"…"} } on each write
 *
 * The server only validates that the body is JSON; it does not inspect the
 * shape. The client decides the document structure and the merge semantics.
 */
export function mountSync(app: Hono, deps: { store: StoreAdapter }) {
  const { store } = deps;

  app.get('/sync', async (c) => {
    if (!store.list) {
      log('sync', 'list unsupported by adapter');
      return c.json({ error: 'listing not supported by this adapter' }, 501);
    }
    const workspaces = await store.list();
    log('sync', 'list', { count: workspaces.length });
    return c.json({ workspaces });
  });

  app.get('/sync/:workspaceId', async (c) => {
    const id = c.req.param('workspaceId');
    let result;
    try {
      result = await store.read(id);
    } catch (err) {
      log('sync', 'pull error', { workspaceId: id, error: (err as Error).message });
      return c.json({ error: (err as Error).message }, 400);
    }
    if (result.body === null || result.etag === null) {
      log('sync', 'pull miss', { workspaceId: id });
      return c.json({ error: 'workspace not found' }, 404);
    }
    log('sync', 'pull', { workspaceId: id, etag: result.etag });
    c.header('ETag', `"${result.etag}"`);
    // Cast to unknown to keep Hono's c.json type inference shallow — the
    // recursive Json type otherwise hits the TS instantiation depth limit.
    return c.json(result.body as unknown);
  });

  app.put('/sync/:workspaceId', async (c) => {
    const id = c.req.param('workspaceId');
    const ifMatchHeader = c.req.header('If-Match');
    const ifMatchEtag = ifMatchHeader ? stripEtagQuotes(ifMatchHeader) : null;

    let body: Json;
    try {
      body = (await c.req.json()) as Json;
    } catch (err) {
      log('sync', 'push bad-json', { workspaceId: id, error: (err as Error).message });
      return c.json({ error: `request body must be valid JSON: ${(err as Error).message}` }, 400);
    }

    const contentLength = Number(c.req.header('content-length') ?? 0);

    let result;
    try {
      result = await store.write(id, body, { ifMatchEtag });
    } catch (err) {
      log('sync', 'push error', { workspaceId: id, error: (err as Error).message });
      return c.json({ error: (err as Error).message }, 400);
    }

    if (!result.ok) {
      log('sync', 'push conflict', {
        workspaceId: id,
        ifMatch: ifMatchEtag,
        currentEtag: result.currentEtag,
      });
      c.header('ETag', `"${result.currentEtag}"`);
      return c.json({ conflict: true, currentEtag: result.currentEtag }, 412);
    }
    log('sync', 'push', {
      workspaceId: id,
      ifMatch: ifMatchEtag,
      etag: result.etag,
      bytes: contentLength,
    });
    c.header('ETag', `"${result.etag}"`);
    return c.json({ ok: true, etag: result.etag });
  });

  app.get('/sync/:workspaceId/stream', (c) => {
    const id = c.req.param('workspaceId');

    return streamSSE(c, async (stream) => {
      log('sync', 'stream open', { workspaceId: id });
      // Send the current etag once on connect so clients can decide whether to
      // pull immediately. null etag means "workspace doesn't exist yet".
      try {
        const initial = await store.read(id);
        await stream.writeSSE({
          event: 'init',
          data: JSON.stringify({ etag: initial.etag }),
        });
        log('sync', 'stream init', { workspaceId: id, etag: initial.etag });
      } catch (err) {
        log('sync', 'stream error', { workspaceId: id, error: (err as Error).message });
        await stream.writeSSE({
          event: 'error',
          data: JSON.stringify({ error: (err as Error).message }),
        });
        return;
      }

      if (!store.watch) {
        // Adapter doesn't support live updates. Send a single message and close
        // so the client falls back to polling.
        log('sync', 'stream watch-unsupported', { workspaceId: id });
        await stream.writeSSE({
          event: 'unsupported',
          data: JSON.stringify({ reason: 'adapter does not implement watch' }),
        });
        return;
      }

      // Bridge adapter callbacks into the SSE stream. Each change re-reads the
      // etag so subscribers don't need a separate pull just to learn it.
      let aborted = false;
      const pending: string[] = [];
      let wake: (() => void) | null = null;

      const unsubscribe = store.watch(id, () => {
        if (aborted) return;
        void (async () => {
          try {
            const r = await store.read(id);
            log('sync', 'stream change', { workspaceId: id, etag: r.etag });
            pending.push(JSON.stringify({ etag: r.etag }));
            wake?.();
          } catch {
            // swallow — next event will retry
          }
        })();
      });

      stream.onAbort(() => {
        log('sync', 'stream close', { workspaceId: id });
        aborted = true;
        unsubscribe();
        wake?.();
      });

      const HEARTBEAT_MS = 25_000;
      let lastBeat = Date.now();

      while (!aborted) {
        if (pending.length > 0) {
          const data = pending.shift()!;
          await stream.writeSSE({ event: 'change', data });
          lastBeat = Date.now();
          continue;
        }
        const now = Date.now();
        const sinceBeat = now - lastBeat;
        if (sinceBeat >= HEARTBEAT_MS) {
          await stream.writeSSE({ event: 'ping', data: String(now) });
          lastBeat = now;
          continue;
        }
        await new Promise<void>((resolve) => {
          wake = resolve;
          setTimeout(resolve, HEARTBEAT_MS - sinceBeat);
        });
        wake = null;
      }
    });
  });
}

function stripEtagQuotes(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}
