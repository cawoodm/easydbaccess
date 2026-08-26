import { defineConfig, searchForWorkspaceRoot } from 'vite';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
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

/** This package's root, so the bar below names a changed file the way you typed it. */
const rendererRoot = fileURLToPath(new URL('.', import.meta.url));

/**
 * What a source change does in dev. `EASYDB_HMR=auto|ask|off`, default `auto`.
 *
 * `auto` is Vite's own behaviour, and for this app that always means a FULL PAGE
 * RELOAD: nothing here calls `import.meta.hot.accept`, so every module is a dead
 * end and every save falls through to one.
 *
 * A reload is not free here the way it is in an ordinary SPA. Boot writes to the
 * database — the workspace record, the seeded view templates (`plugins/views.ts`)
 * — and the store's change broadcast turns those writes into "unsaved changes",
 * so a reload comes back with a red dot on Save. It also closes every open
 * dialog and forgets the window layout.
 *
 * `ask` keeps the watcher and the websocket but sends the page a note instead of
 * an update, and the page offers a Reload button (`src/dev/hmr-prompt.ts`).
 * `off` disconnects the dev client altogether: no websocket, no bar, refresh by
 * hand.
 */
const hmrMode = process.env.EASYDB_HMR ?? 'auto';

/**
 * The custom websocket event `ask` mode sends.
 *
 * A literal in two places on purpose. The other one is in
 * `src/dev/hmr-prompt.ts`; a shared constant would have to live in a module both
 * a Node config and a browser bundle can import, which is a package for one
 * string.
 */
const SOURCE_CHANGED = 'easydb:source-changed';

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
    // Spread rather than `hmr: hmrMode === 'off' ? false : undefined`, because
    // `exactOptionalPropertyTypes` makes an explicit `undefined` a type error —
    // and an absent key is what "leave Vite's default alone" has to mean.
    ...(hmrMode === 'off' ? { hmr: false as const } : {}),
  },
  build: {
    target: 'es2022',
    sourcemap: true,
  },
  // sqlite-wasm finds its `.wasm` file relative to its own module URL. esbuild's
  // dep pre-bundling rewrites that URL into `.vite/deps/`, where the `.wasm` is
  // not, so the worker fails to boot. Excluding it is what the package's own
  // Vite instructions call for.
  optimizeDeps: {
    exclude: ['@sqlite.org/sqlite-wasm'],
  },
  plugins: [
    // `EASYDB_HMR=ask`: tell the page a file changed, and let it decide.
    //
    // Returning an empty module list is Vite's own "nothing matched" — `hmr()`
    // in `vite/dist/node` logs it at debug level and sends the client nothing,
    // so no reload happens. The module graph was already invalidated by the
    // watcher BEFORE this hook ran (`moduleGraph.onFileChange`), so the reload
    // the user eventually asks for still serves the new code.
    //
    // `hotUpdate` rather than `handleHotUpdate`: the older hook is soft-deprecated
    // in Vite 6 and warns by name at every dev start, which is the kind of noise
    // the sourcemap plugin below exists to remove.
    //
    // One thing still reloads on its own: `index.html`. Vite treats an empty
    // module list for an HTML file as "cannot be hot updated" and sends
    // `full-reload` regardless of what this hook returns.
    {
      name: 'hmr-ask-first',
      apply: 'serve',
      hotUpdate(options) {
        if (hmrMode !== 'ask' || this.environment.name !== 'client') return;
        if (options.modules.length === 0) return;
        this.environment.hot.send({
          type: 'custom',
          event: SOURCE_CHANGED,
          data: { file: relative(rendererRoot, options.file).replace(/\\/g, '/') },
        });
        return [];
      },
    },
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
