// packages/renderer/src/chrome/app-progress-signal.ts
//
// The event that drives the app-wide progress bar, and the two helpers that
// raise it. Deliberately separate from the `<app-progress>` element that renders
// it (`app-progress.ts`), for the same reason `panel-title.ts` is separate from
// the panel managers: a caller that only wants to REPORT progress should not
// have to pull in Lit and a custom-element registration to do it.
//
// That is not hypothetical tidiness — the import path here is exercised by unit
// suites running under plain Node, where there is no `document` and no
// `customElements`.

export interface AppProgressDetail {
  /** What is happening, e.g. "Converting northwind.db". Empty hides the bar. */
  label: string;
  /**
   * 0..1, or undefined for indeterminate — "started, nothing measurable yet",
   * which is the honest state before the first batch reports.
   */
  fraction?: number | undefined;
  /** Optional detail line, e.g. "3 of 13 tables". */
  detail?: string | undefined;
}

export const APP_PROGRESS_EVENT = 'easydb:app-progress';

/**
 * Show or update the app-wide bar.
 *
 * A no-op without a `document`: a headless run has nowhere to draw a bar, and
 * reporting progress must never be the thing that breaks the work it reports on.
 */
export function setAppProgress(detail: AppProgressDetail): void {
  if (typeof document === 'undefined') return;
  document.dispatchEvent(new CustomEvent<AppProgressDetail>(APP_PROGRESS_EVENT, { detail }));
}

/** Hide it. Safe to call when it was never shown. */
export function clearAppProgress(): void {
  setAppProgress({ label: '' });
}
