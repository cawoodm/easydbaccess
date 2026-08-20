/**
 * Settings for the app's own chrome — the header and footer button bars.
 *
 * The fields are built HERE, from the live slot registries, rather than declared
 * in the `settings` plugin the way the grid's and the visualizations' are. A
 * per-button field cannot be written down in advance: which buttons exist is
 * whatever the enabled plugins registered this session, and that includes
 * URL-loaded ones the app has never seen before. So the shell — the one place
 * that knows what is in the bars — registers the tab after it snapshots them.
 *
 * Reading stays the same shape as `table/grid-settings.ts`: a `settings.get`
 * per key, defaulting to on when nothing is stored.
 */

import type { ButtonSpec, SettingsFieldSpec } from '@easydb/shared';

export const CHROME_SETTINGS_ID = 'chrome';
export const CHROME_SETTINGS_NAME = 'Buttons';

export type ButtonSlot = 'header' | 'footer';

/** Key for "show button text" in one bar. */
export function buttonTextKey(where: ButtonSlot): string {
  return where === 'header' ? 'headerButtonText' : 'footerButtonText';
}

/** Key for one button's own visibility. Slot-qualified: the two bars are
 *  separate registries and an id only has to be unique within its own. */
export function buttonShownKey(where: ButtonSlot, id: string): string {
  return `show:${where}:${id}`;
}

/** The `api.settings` subset these readers need — same shape grid-settings uses. */
export interface SettingsReader {
  get<T>(pluginId: string, key: string): Promise<T | undefined>;
}

/**
 * Do buttons in this bar show their label next to the icon? Defaults to true:
 * text is what the bars have always shown, and an icon alone is a guess.
 *
 * A narrow screen hides the labels in CSS whatever this says (see the shell's
 * `max-width: 640px` rules) — this setting is about the wide layout, where the
 * user may still want the compact bar.
 */
export async function readButtonText(settings: SettingsReader, where: ButtonSlot): Promise<boolean> {
  return (await settings.get<boolean>(CHROME_SETTINGS_ID, buttonTextKey(where))) !== false;
}

/**
 * The ids in this bar the user has switched off. Only ids that are actually
 * registered are asked about, so a setting left behind by a plugin that is no
 * longer loaded costs nothing and cannot hide a button that reuses its id later.
 */
export async function readHiddenButtons(settings: SettingsReader, where: ButtonSlot, ids: readonly string[]): Promise<Set<string>> {
  const hidden = new Set<string>();
  for (const id of ids) {
    if ((await settings.get<boolean>(CHROME_SETTINGS_ID, buttonShownKey(where, id))) === false) hidden.add(id);
  }
  return hidden;
}

/** One `show:<slot>:<id>` field per registered button, plus the two text switches. */
export function chromeSettingsFields(header: readonly ButtonSpec[], footer: readonly ButtonSpec[]): SettingsFieldSpec[] {
  return [
    {
      key: buttonTextKey('header'),
      label: 'Text in header buttons',
      type: 'boolean',
      default: true,
      scope: 'workspace',
      description: 'Header buttons show their name next to the icon. Turn it off for icons alone, which leaves room for more of them. A phone-width screen hides the text either way.',
    },
    {
      key: buttonTextKey('footer'),
      label: 'Text in footer buttons',
      type: 'boolean',
      default: true,
      scope: 'workspace',
      description: 'The same for the footer bar.',
    },
    ...header.map((b) => buttonField('header', b)),
    ...footer.map((b) => buttonField('footer', b)),
  ];
}

function buttonField(where: ButtonSlot, b: ButtonSpec): SettingsFieldSpec {
  return {
    key: buttonShownKey(where, b.id),
    label: `Show “${b.label}” in the ${where}`,
    type: 'boolean',
    default: true,
    scope: 'workspace',
    ...(b.tooltip ? { description: b.tooltip } : {}),
  };
}
