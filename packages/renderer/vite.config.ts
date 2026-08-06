import { defineConfig, searchForWorkspaceRoot } from 'vite';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { generatePluginCatalog } from '../../scripts/generate-plugin-catalog.mjs';
import { generateTips } from '../../scripts/generate-tips.mjs';
import { resolveDevPort } from '../../scripts/dev-port.mjs';

const require = createRequire(import.meta.url);
// Deps hoist to the primary checkout's node_modules. When the renderer runs
// from a git worktree (`.claude/worktrees/*`) that dir lives OUTSIDE the
// worktree root, so Vite's default fs.allow 403s raw file reads like the
// material-icons .woff behind the @font-face. Allow whichever node_modules
// actually resolves our deps (a no-op in the primary checkout).
const cssPath = require.resolve('material-icons/iconfont/material-icons.css');
const sharedNodeModules = cssPath.slice(0, cssPath.lastIndexOf('node_modules') + 'node_modules'.length);

/** The markdown the `tips` plugin is compiled from — watched by the gen-tips plugin below. */
const tipsSource = fileURLToPath(new URL('../../docs/help/tips.md', import.meta.url));

export default defineConfig({
  server: {
    port: resolveDevPort(),
    // Fail loudly instead of silently drifting to the next free port — a
    // drifted port is exactly what made it hard to tell which branch a dev
    // server was actually serving.
    strictPort: true,
    // Bind all interfaces (not just whichever localhost resolves to first —
    // on some machines that's IPv6-only, so a plain 127.0.0.1 client can't
    // connect even though the server is up). Also what makes ngrok exposure
    // (see allowedHosts below) reachable.
    host: true,
    fs: { allow: [searchForWorkspaceRoot(process.cwd()), sharedNodeModules] },
    // Allow ngrok tunnels (random *.ngrok-free.app subdomain per session) so the
    // dev server can be exposed for external verification. Dev-only; Vite's
    // default host allowlist blocks non-localhost Host headers.
    allowedHosts: ['.ngrok-free.app'],
  },
  build: {
    target: 'es2022',
    sourcemap: true,
  },
  plugins: [
    // Some deps ship a `sourceMappingURL` annotation but not the .map file
    // (some third-party packages do). Vite then logs a "Failed to load source
    // map … ENOENT" on every load, which turns every dev start and every
    // Playwright run into noise. Vite reads the map in its *load* fallback
    // (`loadAndTransform` → `extractSourcemapFromFile`), which runs BEFORE any
    // `transform` hook — so the annotation has to go while loading, and this
    // must be a `load` hook. Only dead annotations are dropped: if the .map
    // exists (or is inline), we return null and Vite loads the file itself.
    {
      name: 'drop-dead-dep-sourcemaps',
      enforce: 'pre',
      load(id: string) {
        const file = id.split('?')[0] ?? '';
        if (!file.includes('node_modules') || !/\.(css|m?js|cjs)$/.test(file)) return null;
        let code: string;
        try {
          code = readFileSync(file, 'utf8');
        } catch {
          return null; // let Vite report an unreadable/missing file as it always did
        }
        let dropped = false;
        const cleaned = code.replace(/\/(?:\*|\/)[#@]\s*sourceMappingURL=(\S+?)\s*(?:\*\/)?[ \t]*$/gm, (annotation, url: string) => {
          if (url.startsWith('data:') || existsSync(resolve(dirname(file), url))) return annotation;
          dropped = true;
          return '';
        });
        return dropped ? { code: cleaned, map: null } : null;
      },
    },
    // Keep public/plugins/catalog.json in sync with the plugin .js files'
    // exported meta on every build/dev start.
    {
      name: 'gen-plugin-catalog',
      async buildStart() {
        await generatePluginCatalog();
      },
    },
    // Recompile src/plugins/tips.json from docs/help/tips.md, the file the
    // `tips` plugin imports. In dev the markdown is watched as well, so editing
    // a tip rewrites the JSON and Vite reloads it like any other source change.
    {
      name: 'gen-tips',
      buildStart() {
        generateTips();
      },
      configureServer(server) {
        server.watcher.add(tipsSource);
        server.watcher.on('change', (file) => {
          if (resolve(file) === tipsSource) generateTips();
        });
      },
    },
  ],
});
