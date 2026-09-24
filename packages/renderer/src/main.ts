import 'material-icons/iconfont/material-icons.css';
import './chrome/app-shell.js';
import './chrome/filter-popover.js';
import { getContext } from './app-context.js';
import { registerServiceWorker } from './pwa/register-sw.js';

// Makes the hosted build load with no internet, and offers a reload when a new
// build is ready. Self-gating: a dev build, the Electron `file:` page and any
// browser without service workers all fall straight through. See
// docs/tech/OFFLINE.md.
registerServiceWorker();

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
  void getContext().then((ctx) => {
    Object.assign(window as unknown as Record<string, unknown>, { __easydb: ctx });
    document.dispatchEvent(new CustomEvent('easydb:test-ready'));
  });
}
