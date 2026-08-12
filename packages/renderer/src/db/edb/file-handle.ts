/**
 * The user's `.edb` files: the folder they live in, picking one, writing it back.
 *
 * **A FOLDER, not a file, is the unit of permission.** One `showDirectoryPicker`
 * grant covers every file inside it, now and later, so the app can list the
 * user's workspaces and create new ones without an OS dialog each time. Granting
 * per file meant a prompt for every New and every Open.
 *
 * The per-file pickers remain, for two cases the folder cannot serve: a browser
 * with no directory picker, and a user who wants a file somewhere else.
 *
 * FileSystemAccess is Chromium-only. Everywhere else `canSaveInPlace()` is false
 * and the caller must fall back to a download — so the Save button can be hidden
 * where it could not work, rather than failing on click.
 *
 * A handle survives a reload: it is structured-cloneable, so it goes in
 * IndexedDB and comes back with its permission needing a re-grant (the browser
 * will not carry write permission across a session silently, and should not).
 */

const DB_NAME = 'easydb-edb-handles';
const STORE = 'handles';
const CURRENT = 'current';
const FOLDER = 'folder';

export const EDB_EXTENSION = '.edb';

/**
 * The File System Access API, as much of it as this module uses.
 *
 * Declared here rather than in an ambient `.d.ts`: TypeScript's DOM lib does not
 * carry this API (Chromium-only, not on a track every engine has adopted), and a
 * global declaration file proved to drop in and out of an incremental `tsc -b`
 * program. Module-local types cannot go missing.
 */
interface PermissionDescriptor {
  mode?: 'read' | 'readwrite';
}

/** Any handle plus the permission methods the DOM lib omits. */
type Permissioned<T> = T & {
  queryPermission(d?: PermissionDescriptor): Promise<PermissionState>;
  requestPermission(d?: PermissionDescriptor): Promise<PermissionState>;
};

type WritableHandle = Permissioned<FileSystemFileHandle>;

/** The DOM lib omits the async iterators, which is how a folder is listed. */
type WritableDir = Permissioned<FileSystemDirectoryHandle> & {
  values(): AsyncIterableIterator<FileSystemHandle>;
};

interface PickerAcceptType {
  description?: string;
  accept: Record<string, string[]>;
}

/** The pickers, as they appear on `globalThis` where the browser has them. */
interface FilePickers {
  showOpenFilePicker?: (o: { types?: PickerAcceptType[]; multiple?: boolean }) => Promise<FileSystemFileHandle[]>;
  showSaveFilePicker?: (o: { suggestedName?: string; types?: PickerAcceptType[] }) => Promise<FileSystemFileHandle>;
  showDirectoryPicker?: (o?: { mode?: 'read' | 'readwrite'; id?: string; startIn?: string }) => Promise<FileSystemDirectoryHandle>;
}

function pickers(): FilePickers {
  return globalThis as unknown as FilePickers;
}

/** The file-picker types both dialogs use, so Open and Save agree on what a workspace is. */
const EDB_TYPES: PickerAcceptType[] = [{ description: 'easyDBAccess workspace', accept: { 'application/x-sqlite3': [EDB_EXTENSION] } }];

/** Can this browser write back to the file the user chose, or only download a copy? */
export function canSaveInPlace(): boolean {
  return typeof pickers().showSaveFilePicker === 'function';
}

/** Can this browser hand over a whole folder at once? */
export function canPickFolder(): boolean {
  return typeof pickers().showDirectoryPicker === 'function';
}

// -- handle persistence -----------------------------------------------------

function openHandleDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('could not open the handle store'));
  });
}

async function withStore<T>(mode: IDBTransactionMode, body: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openHandleDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const req = body(db.transaction(STORE, mode).objectStore(STORE));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error('handle store failed'));
    });
  } finally {
    db.close();
  }
}

export async function rememberHandle(handle: FileSystemFileHandle): Promise<void> {
  await withStore('readwrite', (s) => s.put(handle, CURRENT));
}

export async function forgetHandle(): Promise<void> {
  await withStore('readwrite', (s) => s.delete(CURRENT));
}

/** The handle from a previous session, if there is one. Permission is NOT implied. */
export async function rememberedHandle(): Promise<FileSystemFileHandle | null> {
  try {
    return (await withStore<FileSystemFileHandle | undefined>('readonly', (s) => s.get(CURRENT))) ?? null;
  } catch {
    return null; // private mode, or a store that never existed
  }
}

/**
 * Does this handle still allow writing?
 *
 * Asks first and only prompts when told to: `requestPermission` must be called
 * from a user gesture, so a boot-time check passes `prompt: false` and lets the
 * UI offer a button instead of failing silently.
 *
 * Takes a folder as readily as a file. A granted folder covers everything in it,
 * which is the whole reason the app asks for one.
 */
export async function ensureWritable(handle: FileSystemFileHandle | FileSystemDirectoryHandle, prompt: boolean): Promise<boolean> {
  const h = handle as WritableHandle;
  const opts = { mode: 'readwrite' } as const;
  if ((await h.queryPermission(opts)) === 'granted') return true;
  if (!prompt) return false;
  return (await h.requestPermission(opts)) === 'granted';
}

// -- the workspace folder ---------------------------------------------------

export async function rememberFolder(dir: FileSystemDirectoryHandle): Promise<void> {
  await withStore('readwrite', (s) => s.put(dir, FOLDER));
}

export async function forgetFolder(): Promise<void> {
  await withStore('readwrite', (s) => s.delete(FOLDER));
}

/** The folder from a previous session, if there is one. Permission is NOT implied. */
export async function rememberedFolder(): Promise<FileSystemDirectoryHandle | null> {
  try {
    return (await withStore<FileSystemDirectoryHandle | undefined>('readonly', (s) => s.get(FOLDER))) ?? null;
  } catch {
    return null; // private mode, or a store that never existed
  }
}

/**
 * Ask for the folder the workspaces live in. Null when the user cancels.
 *
 * `id` makes Chromium reopen the picker where it was last time, so a user who
 * changes folder does not start at the top of their disk again.
 */
export function pickFolder(): Promise<FileSystemDirectoryHandle | null> {
  const picker = pickers().showDirectoryPicker;
  if (!picker) return Promise.resolve(null);
  return picker({ mode: 'readwrite', id: 'easydb-workspaces' }).catch(() => null);
}

/** The `.edb` files in a folder, by name, sorted. Directories are ignored. */
export async function listWorkspaceFiles(dir: FileSystemDirectoryHandle): Promise<string[]> {
  const names: string[] = [];
  for await (const entry of (dir as WritableDir).values()) {
    if (entry.kind === 'file' && entry.name.toLowerCase().endsWith(EDB_EXTENSION)) names.push(entry.name);
  }
  return names.sort((a, b) => a.localeCompare(b));
}

/**
 * A file inside the folder. No picker, because the folder grant already covers it.
 *
 * `create` decides whether a missing name is an error or a new file. The caller
 * checks {@link listWorkspaceFiles} first when it needs to warn about a clash —
 * `create: true` on an existing name opens that file, it does not refuse.
 */
export function fileInFolder(dir: FileSystemDirectoryHandle, name: string, create: boolean): Promise<FileSystemFileHandle | null> {
  return dir.getFileHandle(name, { create }).catch(() => null);
}

/** Read a handle's bytes. */
export async function readBytes(handle: FileSystemFileHandle): Promise<Uint8Array> {
  return new Uint8Array(await (await handle.getFile()).arrayBuffer());
}

// -- open / save ------------------------------------------------------------

export interface PickedFile {
  handle: FileSystemFileHandle | null;
  name: string;
  bytes: Uint8Array;
}

/**
 * Ask for a workspace file to open.
 *
 * Falls back to an `<input type=file>` where there is no picker: a file can still
 * be READ everywhere, it just cannot be written back, so `handle` comes back null.
 */
export async function pickFileToOpen(): Promise<PickedFile | null> {
  const picker = pickers().showOpenFilePicker;
  if (picker) {
    const picked = await picker({ types: EDB_TYPES, multiple: false }).catch(() => null);
    const handle = picked?.[0];
    if (!handle) return null; // the user cancelled
    const file = await handle.getFile();
    return { handle, name: handle.name, bytes: new Uint8Array(await file.arrayBuffer()) };
  }
  return new Promise<PickedFile | null>((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = EDB_EXTENSION;
    input.onchange = async () => {
      const file = input.files?.[0];
      resolve(file ? { handle: null, name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) } : null);
    };
    // A cancelled picker fires nothing in some browsers, so the promise may never
    // settle. That is survivable: the caller is a button, and the user can press
    // it again.
    input.click();
  });
}

/** Ask where to write a new workspace file. Null when the user cancels, or cannot be asked. */
export function pickFileToSave(suggestedName: string): Promise<FileSystemFileHandle | null> {
  // Captured rather than called through `globalThis`: `canSaveInPlace()` cannot
  // narrow a global for the compiler, and re-reading it after the check would
  // also be a second chance for it to be missing.
  const picker = pickers().showSaveFilePicker;
  if (!picker) return Promise.resolve(null);
  return picker({ suggestedName, types: EDB_TYPES }).catch(() => null);
}

/**
 * The bytes of one view, in a buffer the DOM types accept.
 *
 * A `Uint8Array` is typed over `ArrayBufferLike`, which includes
 * `SharedArrayBuffer`, and neither `Blob` nor `write()` accepts that. It cannot
 * be shared here — sharing needs COOP/COEP headers this app deliberately runs
 * without — so copying the range out and naming it an `ArrayBuffer` is exact.
 */
function toBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

/** Write the database bytes to a handle, replacing what was there. */
export async function writeBytes(handle: FileSystemFileHandle, bytes: Uint8Array): Promise<void> {
  const writable = await handle.createWritable();
  try {
    await writable.write(toBuffer(bytes));
  } finally {
    // Closing is what commits: an unclosed writable leaves the file untouched.
    await writable.close();
  }
}

/**
 * Last resort where there is no picker — hand the bytes over as a download.
 *
 * Mirrors `api-factory.ts`'s `saveFile`, down to the delayed revoke: revoking the
 * object URL in the same tick can cancel a download that has not started reading
 * yet, and a whole database is large enough for that to matter.
 */
export function downloadBytes(name: string, bytes: Uint8Array): void {
  const url = URL.createObjectURL(new Blob([toBuffer(bytes)], { type: 'application/x-sqlite3' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name.endsWith(EDB_EXTENSION) ? name : `${name}${EDB_EXTENSION}`;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
