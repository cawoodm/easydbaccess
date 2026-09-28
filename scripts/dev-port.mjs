// Resolves the dev-server ports for the CURRENT git branch/worktree, so
// `packages/renderer/vite.config.ts`, the root `playwright.config.ts` and the
// e2e specs all agree without any of them hardcoding a port. See CLAUDE.md's
// "Servers" section for the fixed assignments this enforces.
//
// Two ports per branch:
//   - the renderer (Vite) port         → resolveDevPort()
//   - the offline preview (`npm run preview`) → resolvePreviewPort()
//
// Override either of them for a one-off with RENDERER_PORT=<n> /
// EASYDB_PREVIEW_PORT=<n> (e.g. exposing via ngrok alongside an
// already-running server on the branch's normal port).

import { execSync } from 'node:child_process';

const FIXED_PORTS = {
  main: 5190,
  todos1: 5191,
  todos2: 5192,
};

// Any branch not in FIXED_PORTS still gets a stable port (not a random one
// that can drift call-to-call) by hashing its name into a range clear of the
// fixed ports above.
const FALLBACK_RANGE_START = 5200;
const FALLBACK_RANGE_SIZE = 100;

// The offline preview (`scripts/preview.mjs`) gets a second per-branch port for
// the same reason, and it matters more here than it looks: a service worker is
// scoped to an ORIGIN, so two worktrees sharing one preview port would share
// one worker registration and one cache, and each rebuild would fight the
// other. 7190+ is clear of the renderer range above and of Chrome's
// blocked-port list.
const PREVIEW_PORT_OFFSET = 2000;

function currentBranch() {
  try {
    return execSync('git rev-parse --abbrev-ref HEAD', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null; // not a git checkout (e.g. a packaged build) — caller falls back
  }
}

function hashPort(name) {
  let hash = 0;
  for (const ch of name) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return FALLBACK_RANGE_START + (hash % FALLBACK_RANGE_SIZE);
}

export function resolveDevPort() {
  if (process.env.RENDERER_PORT) return Number(process.env.RENDERER_PORT);
  const branch = currentBranch();
  if (!branch) return FIXED_PORTS.main;
  return FIXED_PORTS[branch] ?? hashPort(branch);
}

export function resolvePreviewPort() {
  if (process.env.EASYDB_PREVIEW_PORT) return Number(process.env.EASYDB_PREVIEW_PORT);
  return resolveDevPort() + PREVIEW_PORT_OFFSET;
}
