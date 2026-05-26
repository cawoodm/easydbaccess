/**
 * Electron main process entry point.
 *
 * For now this is the minimum viable shell: a BrowserWindow that loads the
 * Vite-served renderer in dev (via EASYDB_RENDERER_URL) or the built renderer
 * in production. The renderer continues to use Dexie/IndexedDB locally — the
 * IPC bridge to a main-process better-sqlite3 store lands in a follow-up slice.
 */

import { app, BrowserWindow } from 'electron';
import * as path from 'node:path';

const isDev = !!process.env.EASYDB_RENDERER_URL;

async function createWindow(): Promise<void> {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    title: 'easyDBAccess',
    backgroundColor: '#f3f4f6',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  if (isDev) {
    const url = process.env.EASYDB_RENDERER_URL!;
    await win.loadURL(url);
    win.webContents.openDevTools({ mode: 'detach' });
  } else {
    // Built renderer lives at packages/electron/frontend/index.html, produced
    // by `npm run build:electron --workspace @easydb/renderer` (base=./).
    // Kept separate from packages/renderer/dist/ so the gh-pages build
    // (--base /easydbaccess/) doesn't collide with the file:// build.
    await win.loadFile(path.join(__dirname, '../frontend/index.html'));
  }
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) void createWindow();
});

void app.whenReady().then(createWindow);
