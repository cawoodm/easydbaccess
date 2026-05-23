import 'material-icons/iconfont/material-icons.css';
import './chrome/app-shell.js';
import './chrome/filter-popover.js';
import { getContext } from './app-context.js';

// E2E test hook: when the URL contains `?test=1`, expose the live AppContext
// on `window.__easydb` so Playwright tests can drive the renderer through the
// real HostApi without simulating clicks for every dialog/import/sync action.
// Gated by the query param so production users never pay the cost.
if (typeof location !== 'undefined' && new URLSearchParams(location.search).get('test') === '1') {
  void getContext().then((ctx) => {
    Object.assign(window as unknown as { __easydb: unknown }, { __easydb: ctx });
    document.dispatchEvent(new CustomEvent('easydb:test-ready'));
  });
}
