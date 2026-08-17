/**
 * The full-screen "storage did not start" notice.
 *
 * Lifted almost verbatim from the overlay `db/dexie-db.ts` used when an
 * IndexedDB upgrade was blocked by an older tab — the situation is different but
 * the requirement is identical, and it was already the right shape: fixed,
 * idempotent, `role="alertdialog"`, one obvious action.
 *
 * **Why blocking rather than a toast.** Until the SQLite flip there was always a
 * second store to fall back to, so a failed worker cost the file view and not
 * the app. There is no fallback now. An app that boots, looks fine and holds
 * nothing is a worse failure than one that refuses to start and says why — the
 * user would keep typing into it.
 */

const ID = 'easydb-storage-failure';

/**
 * Show the notice. Idempotent: a second call while it is up does nothing, so a
 * caller does not have to track whether it already fired.
 */
export function showStorageFailure(message: string): void {
  if (typeof document === 'undefined') return;
  if (document.getElementById(ID)) return;
  const el = document.createElement('div');
  el.id = ID;
  el.setAttribute('role', 'alertdialog');
  el.style.cssText =
    'position:fixed;inset:0;z-index:2147483647;display:flex;align-items:center;' + 'justify-content:center;background:rgba(15,23,42,0.55);' + 'font-family:system-ui,sans-serif;padding:1rem;';
  const box = document.createElement('div');
  box.style.cssText = 'max-width:28rem;background:#fff;border-radius:0.6rem;padding:1.5rem 1.75rem;' + 'box-shadow:0 20px 50px rgba(0,0,0,0.3);text-align:center;';

  const title = document.createElement('h2');
  title.textContent = 'Storage could not start';
  title.style.cssText = 'margin:0 0 0.5rem;font-size:1.1rem;color:#111827;';

  const body = document.createElement('p');
  body.style.cssText = 'margin:0 0 1rem;color:#374151;font-size:0.9rem;line-height:1.5;';
  // `textContent`, not `innerHTML`: the message carries an exception string from
  // the worker, which is not ours to trust as markup.
  body.textContent = `easyDBAccess keeps your workspaces in a SQLite database in this browser, and it could not be opened. Your data has not been changed. ${message}`;

  const button = document.createElement('button');
  button.textContent = 'Reload';
  button.style.cssText = 'font:inherit;background:#3b82f6;color:#fff;border:0;padding:0.5rem 1rem;' + 'border-radius:0.3rem;cursor:pointer;';
  button.addEventListener('click', () => location.reload());

  box.append(title, body, button);
  el.append(box);
  document.body.appendChild(el);
}
