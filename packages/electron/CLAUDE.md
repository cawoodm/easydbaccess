# @easydb/electron

Thin desktop shell. A `BrowserWindow` that loads the renderer — Vite in dev,
the built `dist/index.html` in production.

## Files

| File | Role |
|---|---|
| `src/main.ts` | App entry. Creates the BrowserWindow, picks dev vs prod loader, handles `window-all-closed` / `activate`. |
| `src/preload.ts` | contextBridge surface exposed to the renderer as `window.easydb`. Currently just `{ platform: 'electron', version }`. |
| `scripts/dev.cjs` | Boots `dev:renderer` (Vite) first, then launches Electron with `EASYDB_RENDERER_URL` pointing at it. |
| `electron-builder.json` | Packaging config (out of scope for code edits — bumped via the publish scripts at repo root). |

## Dev vs prod

```ts
const isDev = !!process.env.EASYDB_RENDERER_URL;
```

- **Dev**: `dev:electron` runs Vite on port 5190 and sets the URL. The
  window loads it and opens DevTools detached.
- **Prod**: `loadFile(path.join(__dirname, '../../renderer/dist/index.html'))`
  — resolves to `packages/renderer/dist/` relative to
  `packages/electron/dist/main.js`. The renderer must be built first; the
  packaging script handles this.

## Security defaults

`BrowserWindow` is created with `contextIsolation: true`,
`nodeIntegration: false`, `sandbox: true`. Don't relax any of these.
Anything the renderer needs from the main process goes through
`preload.ts` via `contextBridge.exposeInMainWorld`.

## CommonJS, not ESM

This package is `"type": "commonjs"` (the only one in the monorepo).
Electron's main process is happiest on CJS, and `electron-builder` packages
that shape cleanly. Imports use plain TS / ESM-style syntax but compile to
CJS via `tsc`. Don't switch this to ESM without verifying
`electron-builder` still resolves the entry.

## What's intentionally not wired yet

`@easydb/server` is already declared as a runtime dependency in `package.json`
in anticipation, but `src/main.ts` does not import or boot it. The Phase 8
work-items are:

- **Hono in-process** — main process boots `createServer(...)` from
  `@easydb/server` and mounts it on a localhost port. The `store` it passes
  in will be a `better-sqlite3`-backed `StoreAdapter` (not yet implemented in
  the server package; current adapters are `fs-store` and `sqlite-store`
  using `node:sqlite`).
- **Dexie-over-IPC storage adapter** — the renderer's `DataStore` swaps to
  an IPC-backed implementation that proxies to main-process `better-sqlite3`,
  instead of using Dexie/IndexedDB locally. Plugin contract stays identical
  (`DataCollection<T>`); only `db/data-store-dexie.ts` is replaced at boot
  when `window.easydb?.platform === 'electron'`.
- **Native saveFile / openFile** — `api.backend.saveFile` routes through
  Electron's `dialog.showSaveDialog` instead of a `<a download>`.

When you add any of these:

1. Implement on the main side under `src/main.ts` (or split into
   `src/ipc/` if it grows).
2. Expose a minimal surface via `preload.ts` — never the raw Electron API.
3. The renderer's `api.backend` / `DataStore` should NOT branch on
   `window.easydb` — instead, the renderer's `app-context.ts` swaps in an
   Electron-aware adapter when `window.easydb?.platform === 'electron'`.

## Build / package

```bash
npm run dev:electron          # vite + electron (live reload)
npm run build --workspace @easydb/electron
npm run start:electron        # uses already-built dist
npm run package:electron      # electron-builder installer (PowerShell wrapper)
```
