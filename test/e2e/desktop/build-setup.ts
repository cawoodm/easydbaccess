import { execFileSync } from 'node:child_process';

/**
 * Builds what the desktop suite launches.
 *
 * Unlike the browser suite there is no dev server watching sources here — the app
 * loads `packages/electron/dist/main.js` and `packages/electron/frontend/`, both
 * build output. A run against a stale bundle passes or fails on code nobody is
 * editing, which is worse than not running at all, so this always rebuilds.
 *
 * Set `EASYDB_E2E_SKIP_BUILD=1` to skip it while iterating on the specs
 * themselves, when the app code has not moved.
 *
 * Note this writes `packages/electron/frontend/` — the same directory
 * `npm run package:electron` builds into. That is deliberate: the suite tests
 * what the installer would ship, not a separate copy of it.
 */
export default function build(): void {
  if (process.env.EASYDB_E2E_SKIP_BUILD === '1') return;
  // `@easydb/shared` first: `sqlite-store.ts` imports `EdbStore` from its built
  // `dist/`, so an unbuilt shared package means the desktop tests exercise the
  // previous version of the store logic.
  run(['run', 'build', '--workspace', '@easydb/shared']);
  run(['run', 'build', '--workspace', '@easydb/electron']);
  run(['run', 'build:electron', '--workspace', '@easydb/renderer']);
}

function run(args: string[]): void {
  // On Windows this MUST go through a shell. Node refuses to spawn a `.cmd`
  // without one since 18.20.2 / 20.12 (CVE-2024-27980, argument injection into
  // the command interpreter) and answers `EINVAL` — which is what this suite did
  // on every Windows machine, before it had run a single spec.
  //
  // The cost is the DEP0190 warning: with `shell: true` Node concatenates the
  // arguments into a command line itself. Harmless here, where every argument is
  // a literal written above and none of them can contain a space or a quote.
  const win = process.platform === 'win32';
  execFileSync(win ? 'npm.cmd' : 'npm', args, { stdio: 'inherit', shell: win });
}
