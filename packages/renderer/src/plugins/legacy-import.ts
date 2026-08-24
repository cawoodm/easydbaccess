// packages/renderer/src/plugins/legacy-import.ts
//
// Bringing pre-SQLite browser data across.
//
// Until v0.0.383 the browser store was Dexie over an IndexedDB database named
// `easydb`. That database is no longer opened, and the app used to say so and
// stop there — `noticeOrphanedBrowserData`, which this plugin replaces. Its
// advice was to reinstall an older build and export a file, and on a phone that
// is not a path anyone can walk: there is no File System Access API, so the data
// was reachable in principle and stranded in practice.
//
// The copy itself is `db/edb/convert.ts`, unchanged. `db/legacy-idb/` presents
// the old database as a read-only `DataStore`, which is all `copyWorkspace`
// needs — so this file is the decisions and the wording, not an engine.
//
// Design note: `.claude/plans/2026-08-20-legacy-indexeddb-migration.md`.

import type { HostApi, PluginModule } from '@easydb/shared';
import { clearAppProgress, setAppProgress } from '../chrome/app-progress-signal.js';
import { createIpcDataStore } from '../db/data-store-bridge.js';
import { deleteWorkspace } from '../db/delete-workspace.js';
import { storeBridge } from '../db/edb/active-bridge.js';
import { compareCopies } from '../db/edb/copy-facts.js';
import { copyWorkspace } from '../db/edb/convert.js';
import { reloadWithSpace } from '../db/edb/session.js';
import { freeWorkspaceId } from '../db/edb/space-resolve.js';
import { legacyWorkspaceStore } from '../db/legacy-idb/legacy-store.js';
import { buildRemap, identityRemap } from '../db/legacy-idb/remap.js';
import { deleteLegacyDb, openLegacyDb, readLegacyWorkspaceMeta, summariseLegacy, type LegacyDb, type LegacySummary, type LegacyWorkspaceSummary } from '../db/legacy-idb/read.js';
import { countWorkspaceContents } from '../db/delete-workspace.js';

export const meta: NonNullable<PluginModule['meta']> = {
  id: 'legacy-import',
  name: 'Old Browser Data',
  type: 'importer',
  version: '0.1.0',
  description: 'Finds workspaces left behind by versions before the SQLite change and copies them into this one. The only way to that data on a device with no access to files.',
  author: 'Marc Cawood',
  icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v6c0 1.66 4 3 9 3s9-1.34 9-3V5"/><path d="M3 11v6c0 1.66 4 3 9 3s9-1.34 9-3v-6"/></svg>',
  repo: 'https://github.com/cawoodm/easydbaccess/blob/main/packages/renderer/src/plugins/legacy-import.ts',
};

const TITLE = 'Data from an older version';
const FORGET_TITLE = 'Remove data from older versions';

/** Marks the one-time offer as made, so it never nags. Reused from the notice it replaces. */
const OFFERED_KEY = 'easydb:legacy-idb-notice';

const BRING = 'Bring it across';
const NOT_NOW = 'Not now';
const OVERWRITE_LOCAL = 'Replace the one here';
const KEEP_BOTH = 'Keep both, under a new name';
const SKIP = 'Leave this one behind';

/** One noun, singular or plural. */
function plural(n: number, noun: string): string {
  return `${n.toLocaleString()} ${noun}${n === 1 ? '' : 's'}`;
}

/** What was found, as one phrase for the offer. */
function describeFound(s: LegacySummary): string {
  return [plural(s.workspaces.length, 'workspace'), plural(s.tables, 'table'), plural(s.rows, 'row')].join(', ');
}

/**
 * Open the legacy database and summarise it, or `null` when there is nothing
 * worth offering.
 *
 * A database holding workspaces but no tables and no rows counts as nothing: it
 * is the shell an old build made on a visit that never got as far as data, and
 * offering to import it would be a dialog about no content.
 */
async function findLegacy(): Promise<{ db: LegacyDb; summary: LegacySummary } | null> {
  const db = await openLegacyDb();
  if (!db) return null;
  try {
    const summary = await summariseLegacy(db);
    if (summary.workspaces.length === 0 || (summary.tables === 0 && summary.rows === 0)) {
      db.close();
      return null;
    }
    return { db, summary };
  } catch {
    db.close();
    return null;
  }
}

/** What one legacy workspace holds, beside what is already under that id here. */
async function bothCopies(ws: LegacyWorkspaceSummary): Promise<string> {
  let here = {};
  try {
    const c = await countWorkspaceContents(storeBridge(), ws.id, { countRows: false });
    here = { tables: c.tables, views: c.views };
  } catch {
    /* A build that cannot count — the old side's numbers are still worth showing. */
  }
  return compareCopies([
    { label: 'Here now', facts: here },
    { label: 'The older version', facts: { tables: ws.tables, views: ws.views } },
  ]);
}

type Mode = 'fresh' | 'overwrite' | 'rename';

/** What to do with one legacy workspace, asked only when its id is taken. */
async function planFor(api: HostApi, ws: LegacyWorkspaceSummary, taken: ReadonlySet<string>): Promise<{ target: string; mode: Mode } | null> {
  if (!taken.has(ws.id)) return { target: ws.id, mode: 'fresh' };
  const answer = await api.ui.dialogs.choice(
    `"${ws.name}" is already a workspace here. Replace it with the older version's copy, or keep both?${await bothCopies(ws)}`,
    [OVERWRITE_LOCAL, KEEP_BOTH, SKIP],
    TITLE,
  );
  if (!answer || answer === SKIP) return null;
  if (answer === OVERWRITE_LOCAL) return { target: ws.id, mode: 'overwrite' };
  return { target: freeWorkspaceId(ws.id, taken), mode: 'rename' };
}

interface Landed {
  name: string;
  target: string;
  tables: number;
  rows: number;
}

/**
 * Copy one legacy workspace in. Returns what landed, or null when the user
 * declined this one.
 *
 * A rename goes through a remap: `copyWorkspace` writes each document under the
 * id it carries, and `tables` is one collection keyed by table id across every
 * workspace, so keeping both copies needs fresh ids before anything crosses.
 */
async function bringOneIn(api: HostApi, db: LegacyDb, ws: LegacyWorkspaceSummary, taken: Set<string>): Promise<Landed | null> {
  const plan = await planFor(api, ws, taken);
  if (!plan) return null;
  const meta = await readLegacyWorkspaceMeta(db, ws.id);
  if (!meta) return null;

  const remap = plan.mode === 'rename' ? buildRemap(meta, plan.target, () => crypto.randomUUID()) : identityRemap(plan.target);
  const from = legacyWorkspaceStore(db, meta, remap);
  const to = createIpcDataStore(storeBridge(), () => plan.target);

  setAppProgress({ label: `Bringing "${ws.name}" across` });
  try {
    // Replacing means the old contents go first: a copy is additive, so writing
    // over them would leave both sets of tables in one workspace.
    if (plan.mode === 'overwrite') await deleteWorkspace(storeBridge(), plan.target);
    const result = await copyWorkspace(from, to, plan.target, (p) => setAppProgress({ label: `Bringing "${ws.name}" across`, detail: p.label }));
    taken.add(plan.target);
    return { name: ws.name, target: plan.target, tables: result.tables, rows: result.rows };
  } finally {
    clearAppProgress();
  }
}

/**
 * The whole flow: ask, then copy each workspace the user did not skip.
 *
 * Autosave is deliberately NOT batched around this. The events that would do it
 * (`import:before`/`import:after`) carry one table id and a row count, and this
 * is several whole workspaces; `plugins/edb-file.ts` owns that policy and reaches
 * it directly for its own whole-workspace copy, which is not reachable from here.
 * The cost lands only on a user who is in file mode, and the users this exists
 * for have no file at all.
 */
async function run(api: HostApi, found: { db: LegacyDb; summary: LegacySummary }): Promise<void> {
  const { db, summary } = found;
  try {
    const go = await api.ui.dialogs.choice(
      `Data from a version of easyDBAccess before the storage change is still in this browser: ${describeFound(summary)}.\n\n` +
        'It can be copied into this version now. Nothing in the old copy is changed or removed.',
      [BRING, NOT_NOW],
      TITLE,
    );
    if (go !== BRING) return;

    const taken = new Set((await api.store.workspaces.find()).map((w) => w.id));
    const active = api.workspaceId();
    const landed: Landed[] = [];
    for (const ws of summary.workspaces) {
      try {
        const one = await bringOneIn(api, db, ws, taken);
        if (one) landed.push(one);
      } catch (err) {
        // One workspace failing must not strand the others.
        await api.ui.dialogs.alert(`"${ws.name}" could not be copied: ${err instanceof Error ? err.message : String(err)}`, TITLE);
      }
    }

    if (landed.length === 0) {
      api.ui.dialogs.toast('Nothing was copied. The older version’s data is untouched.', { kind: 'info', title: TITLE });
      return;
    }

    const rows = landed.reduce((n, l) => n + l.rows, 0);
    const what = `${plural(landed.length, 'workspace')}, ${plural(rows, 'row')}`;
    // The old copy is still there, and it is the user's decision when it goes —
    // so say where the switch is rather than leaving them to find it.
    api.ui.dialogs.toast(`${what} copied across. The old copy is still in this browser; “${FORGET_TITLE}” removes it.`, { kind: 'success', title: TITLE });

    // A workspace that was replaced under our feet is the one on screen: its
    // panels and plugin host bound to the contents that just went. Rebind.
    if (active && landed.some((l) => l.target === active)) reloadWithSpace(active);
  } finally {
    db.close();
  }
}

/** Delete the legacy database, once the user is satisfied with the copy. */
async function forget(api: HostApi): Promise<void> {
  const found = await findLegacy();
  if (!found) {
    api.ui.dialogs.toast('There is no older-version data in this browser.', { kind: 'info', title: FORGET_TITLE });
    return;
  }
  const { db, summary } = found;
  db.close();
  const ok = await api.ui.dialogs.confirm(
    `Remove the data left by older versions (${describeFound(summary)})?\n\nThis frees the space it uses. It cannot be undone, and anything not copied across is lost.`,
    FORGET_TITLE,
  );
  if (!ok) return;
  try {
    await deleteLegacyDb();
    api.ui.dialogs.toast('The older version’s data has been removed.', { kind: 'success', title: FORGET_TITLE });
  } catch (err) {
    await api.ui.dialogs.alert(`It could not be removed: ${err instanceof Error ? err.message : String(err)}`, FORGET_TITLE);
  }
}

/** The offer, on demand. Says so when there is nothing to offer. */
async function runOnDemand(api: HostApi): Promise<void> {
  const found = await findLegacy();
  if (!found) {
    api.ui.dialogs.toast('No data from older versions was found in this browser.', { kind: 'info', title: TITLE });
    return;
  }
  await run(api, found);
}

export function init(api: HostApi): void {
  api.ui.registerCommand({
    id: 'legacy:import',
    title: 'Import data from an older version',
    group: 'Workspace',
    icon: 'restore',
    keywords: ['legacy', 'indexeddb', 'old', 'migrate', 'recover', 'rescue'],
    run: (a) => runOnDemand(a),
  });
  api.ui.registerCommand({
    id: 'legacy:forget',
    title: FORGET_TITLE,
    group: 'Workspace',
    icon: 'delete_sweep',
    keywords: ['legacy', 'indexeddb', 'old', 'free', 'space', 'clean'],
    run: (a) => forget(a),
  });
}

/**
 * Make the offer once, on the first boot that finds something.
 *
 * The flag is set BEFORE the dialog, not after a successful copy: "Not now" has
 * to stick, or every boot asks again. The palette command is the way back.
 */
export async function load(api: HostApi): Promise<void> {
  try {
    if (globalThis.localStorage?.getItem(OFFERED_KEY)) return;
    const found = await findLegacy();
    if (!found) return;
    globalThis.localStorage?.setItem(OFFERED_KEY, '1');
    await run(api, found);
  } catch {
    /* An offer is not worth failing a boot over. */
  }
}
