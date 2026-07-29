// Resolves the dev-server ports for the CURRENT git branch/worktree, so
// `packages/renderer/vite.config.ts`, the root `playwright.config.ts` and the
// e2e specs all agree without any of them hardcoding a port. See CLAUDE.md's
// "Servers" section for the fixed assignments this enforces.
//
// Two ports per branch:
//   - the renderer (Vite) port      → resolveDevPort()
//   - the e2e backing Hono server   → resolveServerPort()
//
// Override either for a one-off with RENDERER_PORT=<n> / EASYDB_SERVER_PORT=<n>
// (e.g. exposing via ngrok alongside an already-running server on the branch's
// normal port).

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

// The e2e backing Hono server (playwright.config.ts's second webServer) needs
// its own per-branch port for the same reason the renderer does: two worktrees
// running `npm run test:e2e` at once would otherwise fight over one port, and
// the loser silently fails 6 specs — its renderer origin isn't in the winning
// server's CORS_ORIGINS. Deriving it from the renderer port keeps the pair in
// lockstep and inherits the per-branch uniqueness for free.
//
// The offset lands every server port in 6190+, clear of the user's own dev
// servers (3000/3001) and of Chrome's blocked-port list (6000, 6665-6669).
const SERVER_PORT_OFFSET = 1000;

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

export function resolveServerPort() {
  if (process.env.EASYDB_SERVER_PORT) return Number(process.env.EASYDB_SERVER_PORT);
  return resolveDevPort() + SERVER_PORT_OFFSET;
}
