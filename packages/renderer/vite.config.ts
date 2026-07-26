import { defineConfig, searchForWorkspaceRoot } from 'vite';
import { createRequire } from 'node:module';
import { generatePluginCatalog } from '../../scripts/generate-plugin-catalog.mjs';

const require = createRequire(import.meta.url);
// Deps hoist to the primary checkout's node_modules. When the renderer runs
// from a git worktree (`.claude/worktrees/*`) that dir lives OUTSIDE the
// worktree root, so Vite's default fs.allow 403s raw file reads like the
// material-icons .woff behind the @font-face. Allow whichever node_modules
// actually resolves our deps (a no-op in the primary checkout).
const cssPath = require.resolve('material-icons/iconfont/material-icons.css');
const sharedNodeModules = cssPath.slice(
  0,
  cssPath.lastIndexOf('node_modules') + 'node_modules'.length,
);

export default defineConfig({
  server: {
    port: 5190,
    strictPort: false,
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
    // jspanel4 ships a /*# sourceMappingURL=jspanel.css.map */ annotation but
    // not the .map file. Vite logs a noisy ENOENT every time it loads the CSS.
    // Strip the annotation before Vite tries to resolve it.
    {
      name: 'strip-jspanel-css-sourcemap',
      enforce: 'pre',
      transform(code: string, id: string) {
        if (id.includes('jspanel4') && id.endsWith('.css')) {
          return {
            code: code.replace(/\/\*[#@]\s*sourceMappingURL=[^*]*\*\//g, ''),
            map: null,
          };
        }
        return null;
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
  ],
});
