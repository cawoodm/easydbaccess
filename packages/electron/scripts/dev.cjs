#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * Dev runner for the Electron app.
 *
 * 1. Probe the renderer dev server at $EASYDB_RENDERER_URL (default :5190).
 *    If it isn't up, spawn `npm run dev:renderer` from the repo root and wait.
 * 2. Build packages/electron (tsc -b) so dist/main.js + dist/preload.js exist.
 * 3. Launch Electron pointing at the renderer URL.
 * 4. When Electron exits, tear down any Vite process we started.
 */

const { spawn } = require('node:child_process');
const http = require('node:http');
const path = require('node:path');

const RENDERER_URL = process.env.EASYDB_RENDERER_URL || 'http://localhost:5190';
const PKG_DIR = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(PKG_DIR, '..', '..');
const NPM_CMD = process.platform === 'win32' ? 'npm.cmd' : 'npm';

function ping(url) {
  return new Promise((resolve) => {
    const req = http.get(url, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.setTimeout(500, () => {
      req.destroy();
      resolve(false);
    });
  });
}

async function waitFor(url, maxMs = 30_000) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    if (await ping(url)) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: 'inherit', shell: true, ...opts });
    child.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`${cmd} ${args.join(' ')} exited with ${code}`)),
    );
    child.on('error', reject);
  });
}

async function main() {
  let viteProc = null;

  if (!(await ping(RENDERER_URL))) {
    console.log(`[dev:electron] renderer not running, starting it at ${RENDERER_URL} ...`);
    viteProc = spawn(NPM_CMD, ['run', 'dev:renderer'], {
      cwd: REPO_ROOT,
      stdio: 'inherit',
      shell: true,
    });
    const ready = await waitFor(RENDERER_URL);
    if (!ready) {
      console.error('[dev:electron] renderer did not become reachable; aborting.');
      if (viteProc) viteProc.kill();
      process.exit(1);
    }
    console.log('[dev:electron] renderer is up.');
  } else {
    console.log(`[dev:electron] using existing renderer at ${RENDERER_URL}`);
  }

  console.log('[dev:electron] building main + preload ...');
  await run('npx', ['tsc', '-b'], { cwd: PKG_DIR });

  console.log('[dev:electron] launching electron ...');
  // require('electron') from a Node process resolves to the path of the
  // packaged Electron binary.
  const electronBinary = require('electron');
  const electron = spawn(electronBinary, ['.'], {
    cwd: PKG_DIR,
    stdio: 'inherit',
    env: { ...process.env, EASYDB_RENDERER_URL: RENDERER_URL },
  });

  const shutdown = (signal) => () => {
    if (electron.exitCode == null) electron.kill(signal);
    if (viteProc && viteProc.exitCode == null) viteProc.kill(signal);
  };
  process.on('SIGINT', shutdown('SIGINT'));
  process.on('SIGTERM', shutdown('SIGTERM'));

  electron.on('exit', (code) => {
    if (viteProc && viteProc.exitCode == null) viteProc.kill();
    process.exit(code ?? 0);
  });
}

main().catch((err) => {
  console.error('[dev:electron]', err);
  process.exit(1);
});
