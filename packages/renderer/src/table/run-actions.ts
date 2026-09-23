// packages/renderer/src/table/run-actions.ts
//
// What the footer's **Run** button offers.
//
// Run used to be two buttons: Validate's ✓ and the script runner's `</>`. They
// were always the same kind of act — a deliberate, whole-table pass the user
// asks for, that takes a while and reports what it did — so they are one button
// with a menu now.
//
// The menu cannot be a fixed list, because each half is a SEPARATE
// user-toggleable plugin: turning `validate` off in the Plugin Manager has to
// take "Run validations" off the menu, not leave an item that answers nothing.
// So each plugin registers its own action and the button lists whatever is
// registered — the same shape as every other slot registry, kept here rather
// than in `plugin-host/registries.ts` because it is an agreement between two
// built-ins, not part of the plugin contract.
//
// `run-scripts` owns the button itself. Turn that plugin off and the Run button
// goes with it, which is what switching off "Run scripts" now means.

import type { HostApi, Table } from '@easydb/shared';

export interface RunAction {
  /** Menu item id, and the key a duplicate registration replaces. */
  id: string;
  /** What the menu item says. */
  label: string;
  /** Material icon name, shown left of the label. */
  icon?: string;
  /** Lower sorts first. Default 0, ties keep registration order. */
  order?: number;
  /**
   * Can this run do anything on this table? False hides the item — a
   * source-backed or read-only table has nowhere for a script run to write.
   * Omitted ⇒ always offered.
   */
  available?(table: Table): boolean;
  run(api: HostApi, table: Table): Promise<void>;
}

const actions: RunAction[] = [];

/** Add (or replace) an action. Returns the remover, like every other registry. */
export function registerRunAction(action: RunAction): () => void {
  const at = actions.findIndex((a) => a.id === action.id);
  if (at >= 0) actions.splice(at, 1, action);
  else actions.push(action);
  return () => {
    const i = actions.indexOf(action);
    if (i >= 0) actions.splice(i, 1);
  };
}

/** The actions this table can be run through, in menu order. */
export function runActionsFor(table: Table): RunAction[] {
  return actions.filter((a) => !a.available || a.available(table)).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}

/** Test seam: forget every registration. */
export function __resetRunActions(): void {
  actions.length = 0;
}
