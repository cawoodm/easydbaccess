import { resolveServerPort } from '../scripts/dev-port.mjs';

/**
 * Where the e2e backing Hono server lives for THIS checkout.
 *
 * `playwright.config.ts` starts that server (its second `webServer` entry) on
 * the same branch-resolved port, so specs must never hardcode one: two
 * worktrees testing at once each get their own server, and a hardcoded port
 * would point the loser's specs at the winner's server — whose CORS_ORIGINS
 * only names the winner's renderer origin.
 *
 * Set `EASYDB_SERVER_PORT` to pin a specific port for both the server and the
 * specs at once.
 */
export const SERVER_PORT = resolveServerPort();
export const SERVER_URL = `http://localhost:${SERVER_PORT}`;
