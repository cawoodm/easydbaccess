# easyDBAccess

Local-first, plugin-extensible, multi-table database app. Runs in the browser
and as an Electron desktop app. Successor to
[`minniDBMax`](https://github.com/cawoodm/minniDBMax).

**Status:** scaffolding (Phase 1 of the rewrite plan). Not yet runnable.

## Architecture in one paragraph

Lit web components for the chrome, RxDB for state + sync (Dexie storage in the
browser, SQLite via `better-sqlite3` in Electron and on the server), Hono as
the tiny backend (running both inside Electron's main process and as a remote
peer for multi-device sync), TypeScript everywhere. Plugins are vanilla `.js`
ES modules loaded by URL, cached locally, receiving a typed `HostApi` they can
extend or monkey-patch.

For the full design see [`.claude/plans/2026-05-21-rewrite-architecture.md`](./.claude/plans/2026-05-21-rewrite-architecture.md).

## Layout

```
packages/shared/    # types, RxDB schemas, HostApi contract
packages/renderer/  # Lit chrome — browser + Electron renderer
packages/server/    # Hono — runs in Electron main and as a standalone peer
packages/electron/  # Electron shell
plugins-examples/   # reference plugins (.js, loaded by URL)
```

## Scripts (once dependencies are installed)

- `npm run dev` — Vite renderer + Hono server in watch mode
- `npm run dev:electron` — desktop app with HMR
- `npm run build` — all packages
- `npm run typecheck` — TS project references build
- `npm run test` — Vitest across packages
