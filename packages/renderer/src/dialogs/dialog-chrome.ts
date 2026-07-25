import { css } from 'lit';

/**
 * Shared dialog chrome: dark contrasted header bar with the title on the
 * left and primary actions (Save/Cancel/etc.) on the right, plus a
 * close-X in the corner. The body sits below in a `.dialog-body`
 * container that scrolls if its content exceeds the dialog's max-height.
 *
 * Every dialog in `packages/renderer/src/dialogs/` should import these
 * styles and follow the layout:
 *
 *   <dialog>
 *     <button class="close-x">×</button>
 *     <form>
 *       <div class="dialog-header">
 *         <h2>Title</h2>
 *         <div class="header-actions">
 *           <button class="ghost">Cancel</button>
 *           <button class="primary">Save</button>
 *         </div>
 *       </div>
 *       <div class="dialog-body"> … </div>
 *     </form>
 *   </dialog>
 *
 * Individual dialogs may add their own width / body-specific styles
 * on top, but the header colours and button look-and-feel come from
 * this file so the app stays visually consistent.
 */
export const dialogChromeStyles = css`
  :host {
    display: contents;
  }
  dialog {
    position: relative;
    border: 0;
    border-radius: 0.5rem;
    padding: 0;
    box-shadow: 0 20px 50px rgba(0, 0, 0, 0.25);
    font-family: system-ui, sans-serif;
    overflow: hidden;
    max-height: 92vh;
  }
  dialog::backdrop {
    background: rgba(15, 23, 42, 0.4);
  }
  form {
    display: flex;
    flex-direction: column;
    max-height: 92vh;
  }
  .dialog-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    padding: 0.7rem 1.25rem;
    background: #1f2937;
    color: white;
    border-bottom: 1px solid #111827;
    /* Whole bar is the drag handle (draggable.ts wires pointer events);
       cursor is set inline by the helper as it toggles between grab and
       grabbing. */
  }
  .dialog-header h2 {
    margin: 0;
    font-size: 1.05rem;
    color: white;
  }
  .header-actions {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin-right: 2.5rem; /* leave room for the close-x in the corner */
  }
  .dialog-body {
    padding: 1.1rem 1.25rem 1.25rem;
    display: flex;
    flex-direction: column;
    gap: 1rem;
    overflow: auto;
  }
  button.close-x {
    position: absolute;
    top: 0.55rem;
    right: 0.6rem;
    background: transparent;
    border: 0;
    cursor: pointer;
    color: #cbd5e1;
    font-size: 1.1rem;
    padding: 0.15rem 0.3rem;
    line-height: 1;
    border-radius: 0.2rem;
  }
  button.close-x:hover {
    color: white;
    background: rgba(255, 255, 255, 0.12);
  }
  button.primary {
    background: #3b82f6;
    color: white;
    border: 0;
    padding: 0.45rem 0.9rem;
    border-radius: 0.25rem;
    cursor: pointer;
    font: inherit;
  }
  button.primary:hover {
    background: #2563eb;
  }
  button.ghost {
    background: transparent;
    border: 1px solid #d1d5db;
    padding: 0.45rem 0.9rem;
    border-radius: 0.25rem;
    cursor: pointer;
    font: inherit;
  }
  /* Inside the dark header the default ghost (gray-300 on white) doesn't
     have enough contrast, so bump the border + text to a lighter slate. */
  .header-actions button.ghost {
    background: transparent;
    border: 1px solid #6b7280;
    color: #e5e7eb;
  }
  .header-actions button.ghost:hover {
    background: rgba(255, 255, 255, 0.08);
    border-color: #9ca3af;
    color: white;
  }
  /* Phones: every OPEN dialog goes full-screen, edge to edge. The important
     flag plus inset:0 override each dialog's own min/max-width and any inline
     drag position (draggable.ts sets position:fixed + left/top). The dialog
     becomes a flex column so the body fills the remaining height and scrolls,
     keeping the header (and its actions) pinned at the top.

     CRITICAL: scope to dialog[open]. A bare dialog{display:flex !important}
     would override the UA dialog:not([open]){display:none}, leaving a CLOSED
     dialog visible and blocking the whole UI (it never goes away). */
  @media (max-width: 640px) {
    dialog[open] {
      position: fixed !important;
      inset: 0 !important;
      width: auto !important;
      height: auto !important;
      min-width: 0 !important;
      max-width: none !important;
      max-height: none !important;
      margin: 0 !important;
      border-radius: 0 !important;
      display: flex !important;
      flex-direction: column;
    }
    dialog[open] form {
      max-height: none;
      flex: 1;
      min-height: 0;
    }
    dialog[open] .dialog-body {
      flex: 1;
      min-height: 0;
    }
  }
`;

/**
 * Keydown handler that triggers the dialog's primary action (form submit
 * via `requestSubmit`) on Ctrl+Enter / Cmd+Enter. Wire it as
 * `@keydown=${ctrlEnterSubmits}` on the `<dialog>` element so the
 * shortcut works from any input/textarea/select inside, regardless of
 * which one currently has focus.
 *
 * Dialogs without a form (or without a primary action) can skip this —
 * the shortcut is documented as "Save if applicable".
 */
export function ctrlEnterSubmits(e: KeyboardEvent): void {
  if (e.key !== 'Enter' || (!e.ctrlKey && !e.metaKey)) return;
  const root = e.currentTarget;
  if (!(root instanceof HTMLElement)) return;
  const form = root.querySelector('form');
  if (!form) return;
  e.preventDefault();
  form.requestSubmit();
}
