// packages/renderer/src/util/file-link-guard.ts
//
// What happens when a `file:///…` link is clicked in a browser tab.
//
// Nothing good, left alone. A page served over http(s) is not allowed to
// navigate to `file:`, and the browser does not say so: with `target="_blank"` —
// which every link out of this app carries — the click opens a new tab that shows
// `about:blank#blocked` and no explanation at all. It reads as the app refusing to
// open the file, which is exactly backwards: the app allows every scheme the
// `links:protocols` setting allows, and this one is stopped a layer further out.
//
// So the click is caught before the browser can waste a tab on it, and the path
// goes to the clipboard, where it is one paste from the address bar. The desktop
// app is loaded from `file:` itself, so there the link opens and this guard stands
// aside.
//
// One listener on `document`, in the capture phase, which is what lets it cover
// markdown cells, HTML cells, view templates and the Link renderer at once —
// `composedPath()` reaches into their shadow roots. Per-renderer handling would be
// four copies of this rule.

import { schemeOf } from './url-schemes.js';

/**
 * Will the browser refuse to open this link, so that clicking it does nothing a
 * user can see?
 *
 * Only `file:` from a page that is not itself `file:`. A `mailto:` or `obsidian:`
 * hands off to another app and may or may not be registered, which the browser
 * handles without a blank tab, so it is not ours to intercept.
 */
export function pageRefusesLink(href: string, pageProtocol: string): boolean {
  return schemeOf(href) === 'file' && pageProtocol !== 'file:';
}

export function fileLinkMessage(href: string, copied: boolean): string {
  return copied
    ? `A browser tab cannot open a local file. The path is on your clipboard — paste it into a new tab, or use the desktop app.`
    : `A browser tab cannot open a local file: ${href}. Copy the path into a new tab, or use the desktop app.`;
}

/** The anchor a click landed on, shadow roots included, or null. */
function anchorOf(event: Event): HTMLAnchorElement | null {
  for (const node of event.composedPath()) {
    if (node instanceof HTMLAnchorElement) return node;
  }
  return null;
}

async function copy(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Denied permission, or no clipboard at all (http on a non-localhost host).
    return false;
  }
}

/**
 * Start the guard. `notify` gets the message to show — a toast, at the call site,
 * because this module has no business knowing what the app's notifications look
 * like.
 */
export function startFileLinkGuard(notify: (message: string) => void): () => void {
  if (typeof document === 'undefined') return () => {};
  const onClick = (event: Event) => {
    const a = anchorOf(event);
    if (!a) return;
    // The attribute, not `a.href`: the property is resolved against the page, so a
    // relative link would arrive here as `http://localhost/…` and a `file:` one
    // could not be told from it in an Electron build.
    const href = a.getAttribute('href') ?? '';
    if (!pageRefusesLink(href, location.protocol)) return;
    // Only the navigation. The click still reaches the grid, which is how the cell
    // it happened in stays selectable.
    event.preventDefault();
    void copy(href).then((copied) => notify(fileLinkMessage(href, copied)));
  };
  document.addEventListener('click', onClick, true);
  return () => document.removeEventListener('click', onClick, true);
}
