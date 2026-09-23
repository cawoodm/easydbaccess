// packages/renderer/src/db/file-workspaces.ts
//
// The one seam between "a workspace lives in a file" and HOW this build reaches
// files.
//
// Both builds offer the user the same two things — open a workspace that lives
// in another `.edb`, and put a new workspace in its own `.edb` — and they carry
// them out completely differently. The browser adopts a file handle, pushes its
// bytes into the OPFS pool and reloads with `?space=`. The desktop asks the main
// process to switch the store to another path, and the main process reloads the
// window.
//
// `chrome/workspace-actions.ts` must not know which. It asks for the backend
// here, uses it when something installed one, and falls through to the browser
// path when nothing did. That keeps the platform test inside a plugin's `init`,
// which is the rule `packages/electron/CLAUDE.md` states, and it is what let the
// desktop join a feature the browser had had for eighty versions.
//
// Deliberately NOT a plugin registry. A registry is a list, and there is exactly
// one answer to "how does this build reach a file" — a second registration would
// be a bug, not a second backend.

import { ACTIVE_FILE_CHANGED_EVENT } from './edb/session.js';

/** How one build opens and creates file-backed workspaces. */
export interface FileWorkspaceBackend {
  /**
   * Open the workspace `workspaceId` held in `file`.
   *
   * `file` is a NAME, not a path — the folder index deals in names in both
   * builds, so the backend is what knows where the folder is.
   *
   * `unavailable` says the file could not be reached: moved, renamed, or the
   * folder let go since the last scan. The caller reports that. Anything else
   * means the backend has taken over, and a reload is usually already running.
   */
  open(file: string, workspaceId: string): Promise<'opened' | 'unavailable'>;

  /** May a new workspace go in a file of its own right now? */
  canCreate(): Promise<boolean>;

  /**
   * Put a new workspace in its own file and switch to it.
   *
   * False when it did not happen — the user cancelled, or there was nowhere to
   * write. True normally means a reload is on its way.
   */
  create(name: string, workspaceId: string): Promise<boolean>;
}

let backend: FileWorkspaceBackend | null = null;

/**
 * The file THIS build has open, when the build knows it by a name the folder
 * index would recognise. Null everywhere else, and `session.ts`'s
 * `activeEdbName()` is then the answer.
 *
 * Two things read it, and both draw: the workspace selector (which must not list
 * the open file twice) and the Local Data dialog (which ticks that row and
 * disables it). So it has to be readable synchronously — hence a cached name
 * rather than a call — and the setter fires `ACTIVE_FILE_CHANGED_EVENT`, which
 * the selector already listens for.
 *
 * Kept HERE rather than written into `session.ts`'s marker on purpose. That
 * marker also tells the browser's boot which database in the OPFS pool to open
 * and whether a workspace may be created in it (`mayCreateWorkspaceIn`). A
 * desktop file name in it would answer a question the desktop never asks, in a
 * code path the desktop cannot run.
 */
let activeFile: string | null = null;

export function backendActiveFile(): string | null {
  return activeFile;
}

export function setBackendActiveFile(name: string | null): void {
  if (activeFile === name) return;
  activeFile = name;
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(ACTIVE_FILE_CHANGED_EVENT));
}

/**
 * Install this build's backend. Called from a plugin's `init`.
 *
 * Idempotent by overwrite rather than by refusal: a hot-installed plugin runs
 * `init` again, and the second call describes the same build.
 */
export function setFileWorkspaceBackend(b: FileWorkspaceBackend | null): void {
  backend = b;
}

/** This build's backend, or null when it has none and the browser path applies. */
export function fileWorkspaceBackend(): FileWorkspaceBackend | null {
  return backend;
}
