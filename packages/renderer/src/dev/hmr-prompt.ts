// packages/renderer/src/dev/hmr-prompt.ts
//
// The dev-only "source changed — reload?" bar.
//
// Vite's default answer to a source change in this app is a full page reload
// (nothing calls `import.meta.hot.accept`, so every module is a dead end). That
// costs more here than in an ordinary SPA: boot writes to the database, which
// the store's change broadcast counts as unsaved work, and the reload takes
// every open dialog and the window layout with it. Run the dev server with
// `EASYDB_HMR=ask` and it sends this instead — see `vite.config.ts`.
//
// Built from bare DOM with its own shadow root, and from nothing the app owns:
// the change this bar has to survive is a source change, which can be the very
// change that stops the app booting — and a bar made of app parts would not be
// there to press. The shadow root is what keeps the app's stylesheets out of it
// and it out of the app's.
//
// Reached only from `main.ts`'s `import.meta.hot` branch, which a production
// build compiles to `if (undefined)` — so nothing here ships.

/** Must match `SOURCE_CHANGED` in `vite.config.ts`. */
const SOURCE_CHANGED = 'easydb:source-changed';

const STYLE = `
  :host { all: initial; }
  .bar {
    position: fixed;
    inset-block-end: 16px;
    inset-inline-end: 16px;
    z-index: 2147483647;
    display: flex;
    gap: 12px;
    align-items: center;
    max-width: min(420px, calc(100vw - 32px));
    padding: 10px 12px;
    border: 1px solid #d97706;
    border-radius: 8px;
    background: #1f2937;
    box-shadow: 0 6px 20px rgb(0 0 0 / 35%);
    color: #f9fafb;
    font: 13px/1.4 system-ui, sans-serif;
  }
  .text { flex: 1; min-width: 0; }
  .files {
    display: block;
    overflow: hidden;
    color: #9ca3af;
    font-size: 11px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  button {
    flex: none;
    padding: 5px 10px;
    border: 1px solid transparent;
    border-radius: 5px;
    font: inherit;
    cursor: pointer;
  }
  .reload { background: #d97706; color: #111827; font-weight: 600; }
  .later { border-color: #4b5563; background: transparent; color: #d1d5db; }
`;

interface SourceChanged {
  file?: unknown;
}

/**
 * Show the bar on every change until the page is reloaded.
 *
 * The changed files accumulate rather than replace: dismissing the bar and then
 * saving three more files has to end with a bar that says four, not one — a
 * count that resets on dismiss would talk the user out of the reload they need.
 * Only a real reload clears the set, and it does so by taking the page with it.
 */
export function install(): void {
  const hot = import.meta.hot;
  if (!hot) return;

  const changed = new Set<string>();
  let host: HTMLElement | null = null;
  let label: HTMLElement | null = null;
  let files: HTMLElement | null = null;

  function build(): void {
    host = document.createElement('div');
    // A shadow root the app cannot style and cannot be styled by. `all: initial`
    // on the host closes the other direction: inherited properties (font, color)
    // cross a shadow boundary, and the app sets both on `body`.
    const root = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = STYLE;

    const bar = document.createElement('div');
    bar.className = 'bar';

    const text = document.createElement('div');
    text.className = 'text';
    label = document.createElement('strong');
    files = document.createElement('span');
    files.className = 'files';
    text.append(label, files);

    const reload = document.createElement('button');
    reload.className = 'reload';
    reload.textContent = 'Reload';
    reload.addEventListener('click', () => location.reload());

    const later = document.createElement('button');
    later.className = 'later';
    later.textContent = 'Later';
    later.title = 'Hide this. The next change brings it back, still counting.';
    later.addEventListener('click', () => host?.remove());

    bar.append(text, reload, later);
    root.append(style, bar);
    document.body.append(host);
  }

  function render(): void {
    // Rebuilt rather than kept hidden, because *Later* removes it — and because
    // a reload of the app leaves nothing of the previous bar behind either.
    if (!host?.isConnected) build();
    if (!label || !files) return;
    const n = changed.size;
    label.textContent = `${n} source file${n === 1 ? '' : 's'} changed`;
    files.textContent = [...changed].join(', ');
  }

  hot.on(SOURCE_CHANGED, (data: SourceChanged) => {
    if (typeof data?.file === 'string') changed.add(data.file);
    render();
  });
}
