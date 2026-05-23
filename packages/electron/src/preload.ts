/**
 * Preload — bridges the renderer to main-process services via contextBridge.
 *
 * Today this only exposes a version stamp so the renderer can detect Electron.
 * The RxDB-IPC adapter and main-process saveFile/fetch routing land in a
 * follow-up slice; when they do, those handlers attach here.
 */

import { contextBridge } from 'electron';

contextBridge.exposeInMainWorld('easydb', {
  platform: 'electron',
  version: '0.0.1',
});

// Type augmentation for renderer code (informational — the renderer imports
// no Electron types; this lives here so it's discoverable in main.ts edits).
declare global {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  interface Window {
    easydb?: { platform: 'electron'; version: string };
  }
}

export {};
