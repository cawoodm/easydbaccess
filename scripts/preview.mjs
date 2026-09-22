// `npm run preview` — build the app the way CI does and serve it, so the
// service worker is real and you can pull the plug on the server.
//
// The dev server deliberately has NO service worker (`apply: 'build'` on the
// `gen-service-worker` plugin, plus `import.meta.env.PROD` in
// `src/pwa/register-sw.ts`), because a precache in dev would serve yesterday's
// bundle and fight HMR. So stopping `dev:renderer` and reloading gets you
// nothing — that is not the offline path, and this script is. See
// docs/tech/OFFLINE.md.
//
//   npm run preview                # build, stage, serve
//   npm run preview -- --serve     # skip the build, serve what is staged
//   npm run preview -- --slot foo  # base /foo/ instead of /easydbaccess/
//
// Three things this does that a plain `vite preview` cannot:
//
//  1. Builds with `--base /<slot>/` and serves the PARENT directory, so the
//     app really lives at that path. `vite preview` serves at `/`, where the
//     worker's scope would not match and the whole point is lost.
//  2. Serves over http://localhost, which counts as a secure context, so the
//     worker may register at all.
//  3. Takes a per-branch port (`resolvePreviewPort`), because a worker is
//     scoped to an origin and two worktrees on one port would share one
//     registration and one cache.
//
// No new dependency: the static server below is ~40 lines of `node:http`.
// Adding `http-server` for this would be a package for something the standard
// library already does.

import { createServer } from 'node:http';
import { spawnSync } from 'node:child_process';
import { cp, mkdir, readFile, rm, stat } from 'node:fs/promises';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolvePreviewPort } from './dev-port.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const rendererDir = join(root, 'packages', 'renderer');
const stageRoot = join(root, '.preview');

const argv = process.argv.slice(2);
const serveOnly = argv.includes('--serve') || argv.includes('--serve-only');
const slotArg = argv.indexOf('--slot');
const slot = (slotArg !== -1 ? argv[slotArg + 1] : undefined) ?? process.env.EASYDB_PREVIEW_SLOT ?? 'easydbaccess';
const base = `/${slot}/`;
const port = resolvePreviewPort();
const stageDir = join(stageRoot, slot);

/**
 * `.wasm` and `.webmanifest` are the two that actually matter. A wasm served
 * as octet-stream is refused by the streaming compiler, which takes the whole
 * data layer down; a manifest with the wrong type is ignored, so the app
 * silently stops being installable. The rest are ordinary.
 */
const MIME = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.wasm': 'application/wasm',
  '.webmanifest': 'application/manifest+json',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

function run(cmd, args, cwd) {
  const res = spawnSync(cmd, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' });
  if (res.status !== 0) {
    console.error(`\npreview: \`${cmd} ${args.join(' ')}\` failed`);
    process.exit(res.status ?? 1);
  }
}

async function build() {
  // The renderer imports `@easydb/shared` by its package entry, which points at
  // `dist/`. A stale or missing dist there fails the renderer build with a
  // resolve error that reads like a renderer problem.
  run('npm', ['run', 'build', '--workspace', '@easydb/shared'], root);
  run('npm', ['run', 'build', '--workspace', '@easydb/renderer', '--', '--base', base], root);

  // Replace the slot wholesale. Leaving old files behind would let a deleted
  // asset keep answering, which is exactly the staleness this script exists to
  // let you catch.
  await rm(stageDir, { recursive: true, force: true });
  await mkdir(stageDir, { recursive: true });
  await cp(join(rendererDir, 'dist'), stageDir, { recursive: true });
}

async function serve() {
  const server = createServer(async (req, res) => {
    let pathname;
    try {
      pathname = decodeURIComponent(new URL(req.url, `http://localhost:${port}`).pathname);
    } catch {
      res.writeHead(400).end('bad request');
      return;
    }
    if (pathname.endsWith('/')) pathname += 'index.html';

    // Contain the path inside the stage dir — `normalize` collapses `..`, and
    // the prefix check is what stops a crafted URL escaping upward.
    const file = join(stageRoot, normalize(pathname));
    if (!file.startsWith(stageRoot + sep)) {
      res.writeHead(403).end('forbidden');
      return;
    }

    try {
      const info = await stat(file);
      if (info.isDirectory()) {
        res.writeHead(302, { location: `${pathname}/` }).end();
        return;
      }
      const body = await readFile(file);
      res.writeHead(200, {
        'content-type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream',
        // Never let the HTTP cache stand in for the service worker: the whole
        // point of this server is that YOU decide what is reachable.
        'cache-control': 'no-store',
      });
      res.end(body);
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('404');
    }
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`\npreview: port ${port} is already in use.`);
      console.error('Another preview is probably running. Stop it, or set EASYDB_PREVIEW_PORT=<n>.');
      process.exit(1);
    }
    throw err;
  });

  await new Promise((r) => server.listen(port, r));

  console.log(`\n  Offline preview → http://localhost:${port}${base}`);
  console.log(`  Serving         ${stageDir}`);
  console.log('');
  console.log('  Load it once, then stop this server (Ctrl+C) and reload the page.');
  console.log('  The app should still open. `?nosw=1` removes the worker again.');
  console.log('');
}

if (!serveOnly) await build();
else if (!(await stat(stageDir).catch(() => null))) {
  console.error(`preview: nothing staged at ${stageDir} — run \`npm run preview\` without --serve first.`);
  process.exit(1);
}
await serve();
