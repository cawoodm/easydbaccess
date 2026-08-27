import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearWriteGuard, installWriteGuard, writeUserBytes, type WriteGuardDeps } from '../../../packages/renderer/src/db/edb/guarded-write.js';
import type { Holding } from '../../../packages/renderer/src/db/edb/empty-write.js';

/** A confirm mock that keeps its argument types, so the calls can be read back. */
const asker = (answer: boolean) => vi.fn((_file: string, _onDisk: Holding, _writing: Holding) => Promise.resolve(answer));

/**
 * The door in front of every write to a user's file.
 *
 * The contract that matters is the `false`: a refusal must leave the file
 * untouched AND tell the caller nothing happened, because a caller that treats a
 * stopped write as a save marks the workspace clean and loses the work on the
 * next reload anyway.
 */

const bytesOf = (n: number) => new Uint8Array(n).fill(1);

/** A file handle that records what was written to it. */
function fakeHandle(existing: Uint8Array | null) {
  const written: Uint8Array[] = [];
  return {
    written,
    getFile: () =>
      Promise.resolve({
        size: existing?.byteLength ?? 0,
        arrayBuffer: () => Promise.resolve((existing ?? new Uint8Array()).buffer),
      }),
    createWritable: () =>
      Promise.resolve({
        write: (buf: ArrayBuffer) => {
          written.push(new Uint8Array(buf));
          return Promise.resolve();
        },
        close: () => Promise.resolve(),
      }),
  } as unknown as FileSystemFileHandle & { written: Uint8Array[] };
}

/** Peek by byte length: 0 bytes hold nothing, anything else holds one table. */
const peekBySize: WriteGuardDeps['peek'] = (b) => Promise.resolve(b.byteLength === 0 ? [] : [{ tables: 1, views: 0 }]);

const CTX = { file: 'sales.edb', reason: 'Save' };

afterEach(() => {
  clearWriteGuard();
  vi.restoreAllMocks();
});

describe('writeUserBytes', () => {
  it('writes without asking when the bytes hold work', async () => {
    const handle = fakeHandle(bytesOf(64));
    const confirm = asker(true);
    expect(await writeUserBytes(handle, bytesOf(32), CTX, { peek: peekBySize, confirm })).toBe(true);
    expect(handle.written).toHaveLength(1);
    expect(confirm).not.toHaveBeenCalled();
  });

  it('never reads the file when the bytes hold work', async () => {
    // The whole-file read and deserialize is only worth paying for in the
    // dangerous case, which is what keeps an ordinary save the speed it was.
    const handle = fakeHandle(bytesOf(64));
    const getFile = vi.spyOn(handle, 'getFile');
    await writeUserBytes(handle, bytesOf(32), CTX, { peek: peekBySize, confirm: () => Promise.resolve(true) });
    expect(getFile).not.toHaveBeenCalled();
  });

  it('writes an empty database to a file that holds nothing, with no question', async () => {
    // A first save is exactly this.
    const handle = fakeHandle(null);
    const confirm = asker(true);
    expect(await writeUserBytes(handle, new Uint8Array(), CTX, { peek: peekBySize, confirm })).toBe(true);
    expect(confirm).not.toHaveBeenCalled();
    expect(handle.written).toHaveLength(1);
  });

  it('ASKS before writing an empty database over a full one', async () => {
    const handle = fakeHandle(bytesOf(64));
    const confirm = asker(true);
    expect(await writeUserBytes(handle, new Uint8Array(), CTX, { peek: peekBySize, confirm })).toBe(true);
    expect(confirm).toHaveBeenCalledOnce();
    expect(confirm.mock.calls[0]?.[0]).toBe('sales.edb');
    expect(handle.written).toHaveLength(1);
  });

  it('writes NOTHING when the question is refused, and says so', async () => {
    const handle = fakeHandle(bytesOf(64));
    const onRefused = vi.fn((_file: string, _onDisk: Holding) => undefined);
    const wrote = await writeUserBytes(handle, new Uint8Array(), CTX, { peek: peekBySize, confirm: () => Promise.resolve(false), onRefused });
    expect(wrote).toBe(false);
    expect(handle.written).toEqual([]);
    expect(onRefused).toHaveBeenCalledOnce();
    expect(onRefused.mock.calls[0]?.[0]).toBe('sales.edb');
  });

  it('hands the question both sides, so the dialog can quote them', async () => {
    const handle = fakeHandle(bytesOf(64));
    const confirm = asker(false);
    await writeUserBytes(handle, new Uint8Array(), CTX, { peek: peekBySize, confirm });
    const call = confirm.mock.calls[0];
    expect(call?.[1].tables).toBe(1);
    expect(call?.[2].tables).toBe(0);
  });

  it('writes when the file cannot be read: an unreadable file holds nothing to lose', async () => {
    // A guard that blocked every write it could not reason about would be turned
    // off within an hour. The risk is one-sided on purpose.
    const handle = fakeHandle(bytesOf(64));
    vi.spyOn(handle, 'getFile').mockRejectedValue(new Error('gone'));
    const confirm = asker(true);
    expect(await writeUserBytes(handle, new Uint8Array(), CTX, { peek: peekBySize, confirm })).toBe(true);
    expect(confirm).not.toHaveBeenCalled();
  });

  it('uses the installed guard when the caller passes none', async () => {
    // `new-file.ts` cannot reach the dialog, so it relies on this.
    const handle = fakeHandle(bytesOf(64));
    const confirm = asker(false);
    installWriteGuard({ peek: peekBySize, confirm });
    expect(await writeUserBytes(handle, new Uint8Array(), CTX)).toBe(false);
    expect(confirm).toHaveBeenCalledOnce();
    expect(handle.written).toEqual([]);
  });

  it('writes with no guard installed, rather than refusing every save', async () => {
    const handle = fakeHandle(bytesOf(64));
    expect(await writeUserBytes(handle, new Uint8Array(), CTX)).toBe(true);
    expect(handle.written).toHaveLength(1);
  });
});
