// Resolves the renderer dev-server port for the CURRENT git branch/worktree,
// so `packages/renderer/vite.config.ts` and the root `playwright.config.ts`
// agree on one port without either hardcoding 5190. See CLAUDE.md's "Servers"
// section for the fixed assignments this enforces.
//
// Override with RENDERER_PORT=<n> for a one-off (e.g. exposing via ngrok
// alongside an already-running server on the branch's normal port).

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
