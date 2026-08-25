import type { HostApi, PluginModule } from '@easydb/shared';
import { CATALOG_URLS_SETTING, defaultCatalogUrl, fetchCatalog, type CatalogResolved } from '../plugin-host/plugin-catalog.js';

/**
 * Says when the catalog has something in it the user has never had.
 *
 * A plugin catalog gains entries when the app is updated, and nothing told anyone:
 * the Plugin Manager lists them, but only if you go and look. So a plugin shipped
 * in v0.0.500 was invisible to every user who never opened that dialog again.
 *
 * The rule is deliberately narrow, because the failure mode of a boot prompt is
 * nagging. A plugin is worth mentioning only when all three hold:
 *
 *  1. it is not installed now,
 *  2. this browser has never held it — no record in the `plugins` collection, so
 *     one the user installed and later removed stays quiet,
 *  3. it has not been mentioned before.
 *
 * The third is what makes it once-only, and it is written down twice on purpose.
 * The list of mentioned URLs goes to the device layer AND to the workspace's own
 * settings, because the device layer is `localStorage` and therefore per ORIGIN —
 * the same workspace opened on another dev server, on the published site, or after
 * site data was cleared, asked about the same plugin a second time. See
 * {@link MENTIONED_SETTING}.
 *
 * Either way it is written BEFORE the question is asked, so declining, closing the
 * tab or reloading all count as having been told.
 */
export const meta: NonNullable<PluginModule['meta']> = {
  id: 'new-plugins',
  name: 'New Plugins',
  type: 'ui',
  version: '0.1.0',
  description: 'Mentions catalog plugins you have never installed, once each, and offers to open the Plugin Manager.',
  author: 'Marc Cawood',
  icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3v6"/><path d="M9 6h6"/><path d="M5 12h14v7a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2z"/></svg>',
  repo: 'https://github.com/cawoodm/easydbaccess/blob/main/packages/renderer/src/plugins/new-plugins.ts',
};

/** Device-local list of catalog URLs already mentioned. */
const MENTIONED_KEY = 'mentioned';

/**
 * The same list again, in the WORKSPACE's own settings.
 *
 * Two stores for one fact, because neither covers the case on its own. The device
 * layer is `localStorage`, so it is per ORIGIN: the same workspace opened on
 * another branch's dev server, on the published site, or after site data is
 * cleared, had never been told anything and asked again — "notified twice about
 * the same plugin", which is the whole thing this plugin exists to avoid. The
 * workspace layer travels with the workspace, through its `.edb` and through sync.
 *
 * A separate KEY rather than the same one in the other layer: `settings.set`
 * writes one layer and deletes the key from the other, so one name could never
 * hold both.
 *
 * Read as a UNION, written to both. The failure mode of a stale entry is silence
 * about one plugin, which the "Show available plugins" command answers; the
 * failure mode of a lost entry is nagging, which nothing answers.
 */
const MENTIONED_SETTING = 'new-plugins:mentioned-here';

/**
 * Which catalog entries are worth mentioning.
 *
 * Pure, and the whole decision — everything around it is fetching and asking.
 * Keyed on the absolute URL rather than the id, because the id is a catalog's own
 * label and two catalogs may well both offer a `cell-email`; the URL is what gets
 * installed and what the `plugins` collection is keyed by.
 *
 * Duplicates across catalogs collapse: the same URL offered twice is one plugin.
 */
export function unmentionedPlugins(catalog: readonly CatalogResolved[], installed: ReadonlySet<string>, known: ReadonlySet<string>, mentioned: ReadonlySet<string>): CatalogResolved[] {
  const out: CatalogResolved[] = [];
  const seen = new Set<string>();
  for (const entry of catalog) {
    if (seen.has(entry.absUrl)) continue;
    if (installed.has(entry.absUrl) || known.has(entry.absUrl) || mentioned.has(entry.absUrl)) continue;
    seen.add(entry.absUrl);
    out.push(entry);
  }
  return out;
}

/** "Email Renderer, Header Clock and one more" — a list a sentence can hold. */
export function nameList(entries: readonly CatalogResolved[], limit = 3): string {
  const names = entries.slice(0, limit).map((e) => e.name);
  const rest = entries.length - names.length;
  const listed = names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : (names[0] ?? '');
  if (rest <= 0) return listed;
  return `${listed}, and ${rest} more`;
}

/**
 * E2E specs boot the app on every test, and a modal on boot intercepts the first
 * click. Suppressed under `?test=1` exactly as `tips` is, with `?plugins=1` to
 * force it back on for the spec that tests it.
 */
function suppressed(): boolean {
  if (typeof location === 'undefined') return true;
  const sp = new URLSearchParams(location.search);
  if (sp.get('plugins') === '1') return false;
  return sp.get('test') === '1';
}

/** The strings in a stored value that could be a list of URLs, or anything at all. */
export function urlList(stored: unknown): string[] {
  return Array.isArray(stored) ? stored.filter((u): u is string => typeof u === 'string') : [];
}

/** Every URL either store has been told about, once each and in a stable order. */
export function mergeMentioned(device: readonly string[], workspace: readonly string[]): string[] {
  return [...new Set([...device, ...workspace])];
}

async function readMentioned(api: HostApi): Promise<string[]> {
  const device = urlList(await api.settings.get<unknown>(meta.id, MENTIONED_KEY));
  const workspace = urlList((await api.store.settings.findOne(MENTIONED_SETTING))?.value);
  return mergeMentioned(device, workspace);
}

/** The catalog sources the user actually uses — the same setting the Plugin Manager keeps. */
async function catalogUrls(api: HostApi): Promise<string[]> {
  const saved = await api.store.settings.findOne(CATALOG_URLS_SETTING);
  const list = Array.isArray(saved?.value) ? (saved.value as unknown[]).filter((v): v is string => typeof v === 'string') : [];
  return list.length > 0 ? list : [defaultCatalogUrl()];
}

/**
 * Every entry from every configured catalog.
 *
 * A source that cannot be read contributes nothing and says nothing. This runs on
 * boot, where the commonest reason for a failed fetch is being offline — and an
 * error about a catalog nobody asked for is noise, not news.
 */
async function everyEntry(api: HostApi): Promise<CatalogResolved[]> {
  const all: CatalogResolved[] = [];
  for (const url of await catalogUrls(api)) {
    try {
      all.push(...(await fetchCatalog(url)));
    } catch {
      /* offline, or a catalog that has moved — nothing to report */
    }
  }
  return all;
}

/** What is installed now, and what this browser has ever held. */
async function urlsHere(api: HostApi): Promise<{ installed: Set<string>; known: Set<string> }> {
  const id = api.workspaceId();
  // No workspace yet is possible in principle and answers "nothing is installed",
  // which is the safe direction: the mentioned list still stops a second question.
  const ws = id ? await api.store.workspaces.findOne(id) : null;
  const records = await api.store.plugins.find();
  return {
    installed: new Set(ws?.pluginUrls ?? []),
    // A record survives an uninstall, which is what makes "never have been" answerable
    // at all: the URL is still there with its cached body, just not in `pluginUrls`.
    known: new Set(records.map((r) => r.url)),
  };
}

/** The check itself. `mention` false ignores the mentioned list — for the command. */
async function findNew(api: HostApi, mention: boolean): Promise<CatalogResolved[]> {
  const catalog = await everyEntry(api);
  if (catalog.length === 0) return [];
  const { installed, known } = await urlsHere(api);
  const mentioned = new Set(mention ? await readMentioned(api) : []);
  return unmentionedPlugins(catalog, installed, known, mentioned);
}

/**
 * Write the mention to both stores.
 *
 * Both, and neither failure is fatal: a device layer that cannot be written
 * (private mode) still leaves the workspace copy, and a workspace that cannot be
 * written still leaves the device copy. Silence about a plugin is the safe
 * direction — see {@link MENTIONED_SETTING}.
 */
async function markMentioned(api: HostApi, entries: readonly CatalogResolved[]): Promise<void> {
  const next = mergeMentioned(
    await readMentioned(api),
    entries.map((e) => e.absUrl),
  );
  await api.settings.set(meta.id, MENTIONED_KEY, next, 'user').catch(() => undefined);
  await api.store.settings.upsert({ name: MENTIONED_SETTING, value: next }).catch(() => undefined);
}

function sentence(entries: readonly CatalogResolved[]): string {
  const count = entries.length === 1 ? 'One plugin you have never installed is' : `${entries.length} plugins you have never installed are`;
  return `${count} available: ${nameList(entries)}.\n\nOpen the Plugin Manager to look at them?`;
}

export function init(api: HostApi): void {
  api.ui.registerCommand({
    id: 'new-plugins:show',
    title: 'Show available plugins',
    group: 'Help',
    icon: 'extension',
    keywords: ['plugin', 'new', 'available', 'catalog'],
    // Asked on purpose, so the mentioned list is ignored — the same reasoning as
    // `tips:show`, which starts the tour over rather than saying nothing.
    run: async (a) => {
      const fresh = await findNew(a, false);
      if (fresh.length === 0) {
        a.ui.dialogs.toast('Every plugin in your catalogs is already installed here.', { kind: 'info' });
        return;
      }
      await markMentioned(a, fresh);
      if (await a.ui.dialogs.confirm(sentence(fresh), 'Available plugins')) a.ui.openPluginManager();
    },
  });
}

/**
 * Mentions anything new, once, after the app is ready.
 *
 * This plugin is LAST in the built-in list on purpose. `load()` runs the built-ins
 * in order and awaits each one, and two of them already open something on boot
 * (`tips`, `legacy-import`) — going last means this question never lands on top of
 * one of those, and a slow catalog fetch delays nothing behind it.
 */
export async function load(api: HostApi): Promise<void> {
  if (suppressed()) return;
  const fresh = await findNew(api, true);
  if (fresh.length === 0) return;
  // Before the question, not after: a reload while it is open, or a tab closed on
  // it, both count as having been told. Otherwise the same question returns every
  // boot, which is the one outcome worse than not asking at all.
  await markMentioned(api, fresh);
  if (await api.ui.dialogs.confirm(sentence(fresh), 'New plugins')) api.ui.openPluginManager();
}
