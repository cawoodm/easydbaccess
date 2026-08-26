import 'material-icons/iconfont/material-icons.css';
import './chrome/app-shell.js';
import './chrome/filter-popover.js';
import { getContext } from './app-context.js';

// The dev "source changed — reload?" bar, for `EASYDB_HMR=ask` (see
// `vite.config.ts`). Loaded whenever a dev server is behind the page; under the
// default `EASYDB_HMR=auto` the server never sends the event, so the bar is
// installed and silent. `import.meta.hot` is `undefined` in a production build,
// which makes this branch statically dead and drops the module from the bundle.
if (import.meta.hot) {
  void import('./dev/hmr-prompt.js').then((m) => m.install());
}

// E2E test hook: when the URL contains `?test=1`, expose the live AppContext
// on `window.__easydb` so Playwright tests can drive the renderer through the
// real HostApi without simulating clicks for every dialog/import/sync action.
// Gated by the query param so production users never pay the cost.
if (typeof location !== 'undefined' && new URLSearchParams(location.search).get('test') === '1') {
  void Promise.all([getContext(), import('./plugins/auto-sync.js')]).then(([ctx, autoSync]) => {
    Object.assign(window as unknown as Record<string, unknown>, {
      __easydb: ctx,
      // Lets the auto-sync e2e spec fire one tick on demand instead of
      // waiting the full 60s interval.
      __autoSyncTick: () => autoSync.tick(ctx.api),
    });
    document.dispatchEvent(new CustomEvent('easydb:test-ready'));
  });
}
