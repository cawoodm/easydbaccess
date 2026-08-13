// packages/renderer/src/viz/viz-options.ts
//
// How a visualization's options are layered. Pure, so the rules are unit-tested
// rather than inferred from three call sites.
//
// There are three places a value can come from, and each exists for a reason:
//
//  1. **Workspace settings** (Settings → Visualizations) — the DEFAULTS a new
//     visualization starts with. Copied in once, at creation; they are a starting
//     point, not a live override, so changing them never rewrites a chart somebody
//     already tuned.
//  2. **The template** (`VizSpec.options`) — the shared definition. One "Top
//     words" chart used against five tables.
//  3. **The instance** (`ViewInstance.vizOptions`) — this view of that template.
//
// Layer 3 exists because the options that matter most in practice are exactly the
// ones that differ per table: which words to ignore in THIS column, how short is
// too short for THIS data. Without it, varying one option meant copying the whole
// template and losing the connection to it.
//
// The load-bearing rule is that an instance stores only what it actually
// CHANGES. Storing the full resolved set would silently freeze a copy, and a
// later template edit would stop reaching the instance — inheritance that quietly
// stops inheriting is worse than no inheritance at all.

export type VizOptionValues = Record<string, unknown>;

/**
 * What the visualization actually draws with: the instance's overrides on top of
 * the template's options.
 *
 * A key present in the override with the value `undefined` is treated as absent,
 * so clearing an override reverts to the template rather than to nothing.
 */
export function effectiveVizOptions(templateOptions: VizOptionValues | undefined, instanceOverrides: VizOptionValues | undefined): VizOptionValues {
  const out: VizOptionValues = { ...(templateOptions ?? {}) };
  for (const [k, v] of Object.entries(instanceOverrides ?? {})) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}

/** Do these two option values mean the same thing? */
function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  // An absent option and an empty string are the same answer for a text field,
  // and an editor that renders `undefined` as `''` would otherwise record an
  // override the user never made.
  const blank = (v: unknown): boolean => v === undefined || v === null || v === '';
  if (blank(a) && blank(b)) return true;
  // A number typed into a text input arrives as a string.
  if (typeof a === 'number' || typeof b === 'number') {
    const na = Number(a);
    const nb = Number(b);
    if (Number.isFinite(na) && Number.isFinite(nb)) return na === nb;
  }
  return false;
}

/**
 * The overrides worth STORING: every key whose edited value differs from what the
 * template says, and nothing else.
 *
 * `edited` is the full set the editor was showing (template values with the
 * user's changes applied), which is why this has to diff rather than trust it.
 */
export function overrideDelta(templateOptions: VizOptionValues | undefined, edited: VizOptionValues | undefined): VizOptionValues {
  const tpl = templateOptions ?? {};
  const out: VizOptionValues = {};
  for (const [k, v] of Object.entries(edited ?? {})) {
    if (!sameValue(v, tpl[k])) out[k] = v;
  }
  return out;
}

/** Which keys this instance overrides — what an editor marks as "not inherited". */
export function overriddenKeys(templateOptions: VizOptionValues | undefined, instanceOverrides: VizOptionValues | undefined): Set<string> {
  return new Set(Object.keys(overrideDelta(templateOptions, instanceOverrides)));
}
