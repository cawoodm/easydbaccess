import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { readFile, writeFile, rename, readdir, mkdir, unlink, stat } from 'node:fs/promises';
import { watch as fsWatch, type FSWatcher } from 'node:fs';
import { join } from 'node:path';
import type { Json, StoreAdapter, Unsubscribe, WriteResult } from './types.js';

/**
 * Stores each workspace as ${rootDir}/${workspaceId}.db.json — same extension
 * the dump-export plugin uses, so a file dropped here is also a valid dump file
 * (and vice versa).
 *
 * Writes are atomic (temp file + rename). Etag is sha1 of the serialized JSON.
 * Workspace IDs are restricted to [A-Za-z0-9_.-] to avoid path traversal.
 */
export function filesystemStoreAdapter(rootDir: string): StoreAdapter {
  const emitter = new EventEmitter();
  let watcher: FSWatcher | null = null;
  const debounceTimers = new Map<string, NodeJS.Timeout>();

  const path = (id: string) => join(rootDir, `${id}.db.json`);
  const tmpPath = (id: string) => join(rootDir, `${id}.db.json.tmp-${process.pid}-${Date.now()}`);
  const validate = (id: string) => {
    if (!/^[A-Za-z0-9_.-]+$/.test(id)) {
      throw new Error(`invalid workspaceId: ${id}`);
    }
  };

  async function ensureRoot(): Promise<void> {
    await mkdir(rootDir, { recursive: true });
  }

  function ensureWatcher(): void {
    if (watcher) return;
    // fs.watch can fire many events for one write (rename + change); we debounce
    // per workspace so subscribers see one notification per logical write.
    watcher = fsWatch(rootDir, { persistent: false }, (_event, filename) => {
      if (!filename) return;
      const m = /^(.+)\.db\.json$/.exec(filename);
      if (!m) return;
      const id = m[1]!;
      const existing = debounceTimers.get(id);
      if (existing) clearTimeout(existing);
      debounceTimers.set(
        id,
        setTimeout(() => {
          debounceTimers.delete(id);
          emitter.emit(`change:${id}`);
        }, 50),
      );
    });
  }

  return {
    async read(workspaceId) {
      validate(workspaceId);
      let text: string;
      try {
        text = await readFile(path(workspaceId), 'utf8');
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          return { body: null, etag: null };
        }
        throw err;
      }
      const body = JSON.parse(text) as Json;
      return { body, etag: sha1(text) };
    },

    async write(workspaceId, body, opts): Promise<WriteResult> {
      validate(workspaceId);
      await ensureRoot();
      const text = JSON.stringify(body);
      const newEtag = sha1(text);

      if (opts.ifMatchEtag !== null) {
        let currentEtag: string | null = null;
        try {
          const current = await readFile(path(workspaceId), 'utf8');
          currentEtag = sha1(current);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
        }
        if (currentEtag !== opts.ifMatchEtag) {
          return { ok: false, conflict: true, currentEtag: currentEtag ?? '' };
        }
      }

      const tmp = tmpPath(workspaceId);
      await writeFile(tmp, text, 'utf8');
      try {
        await rename(tmp, path(workspaceId));
      } catch (err) {
        await unlink(tmp).catch(() => {});
        throw err;
      }
      return { ok: true, etag: newEtag };
    },

    watch(workspaceId, fn): Unsubscribe {
      validate(workspaceId);
      ensureWatcher();
      const event = `change:${workspaceId}`;
      emitter.on(event, fn);
      return () => emitter.off(event, fn);
    },

    async list(): Promise<string[]> {
      try {
        const entries = await readdir(rootDir);
        const ids: string[] = [];
        for (const name of entries) {
          const m = /^(.+)\.db\.json$/.exec(name);
          if (!m) continue;
          const full = join(rootDir, name);
          try {
            const s = await stat(full);
            if (s.isFile()) ids.push(m[1]!);
          } catch {
            // skip vanished entries
          }
        }
        return ids;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
        throw err;
      }
    },

    async close(): Promise<void> {
      if (watcher) {
        watcher.close();
        watcher = null;
      }
      for (const t of debounceTimers.values()) clearTimeout(t);
      debounceTimers.clear();
      emitter.removeAllListeners();
    },
  };
}

function sha1(text: string): string {
  return createHash('sha1').update(text, 'utf8').digest('hex');
}
