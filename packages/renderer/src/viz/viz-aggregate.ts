// packages/renderer/src/viz/viz-aggregate.ts
//
// Rows in, plottable frame out. The one place that decides what a chart of a
// table actually MEANS.
//
// DOM-free, Dexie-free, no Lit — so vitest exercises it directly, the same way
// `views/view-render.ts` and `plugins/projection-compute.ts` are tested. It sits
// in the renderer rather than `@easydb/shared` for one reason: a scripted column
// has no value until `util/column-script.ts` runs it here, so aggregation has to
// happen after script evaluation and cannot be shared with the Electron main
// process.
//
// Three rules worth stating, because each is a way a naive aggregator lies:
//
//  - An empty group key is a CATEGORY, not a row to drop. "How many rows have no
//    country" is exactly the question a chart is often asked, and silently
//    dropping them makes the bars add up to less than the table.
//  - A value that is not a number is SKIPPED and COUNTED, never coerced. `Number('')`
//    is 0 and `Number('n/a')` is NaN; both would invent data — one by adding a
//    zero that is not there, the other by poisoning the whole sum.
//  - `topN` folds the tail into one "Other" bar rather than hiding it. A chart
//    that silently drops 200 small categories reads as though they do not exist.

import type { ColumnSpec, Row, VizAggregate, VizBinUnit, VizMeasureFn } from '@easydb/shared';
import { arrayMembers } from '@easydb/shared';
import { compareValues } from '../table/row-sort.js';

/** The label a group with no value gets. Shown, never dropped. */
export const EMPTY_LABEL = '(empty)';
/** The label the `topN` tail folds into. */
export const OTHER_LABEL = 'Other';

/** One plotted category — a group of rows sharing the same group-key values. */
export interface VizCategory {
  /** Join of the raw group values; unique within the frame. */
  key: string;
  label: string;
  /**
   * The raw group values, in `groupBy` order. Carried so a future cross-filter
   * can build an exact-match filter from a clicked bar without re-deriving it.
   */
  values: unknown[];
}

/** One plotted series — one measure, evaluated over every category in order. */
export interface VizSeries {
  key: string;
  label: string;
  /** One entry per category, same index. `null` where the group had no usable value. */
  points: Array<number | null>;
}

export interface VizFrame {
  categories: VizCategory[];
  series: VizSeries[];
  /** Rows the frame was built from. */
  rowCount: number;
  /** The row set was capped upstream, so this frame is a partial answer. */
  truncated: boolean;
  /**
   * Values skipped because a `sum`/`avg`/`min`/`max` measure could not read them
   * as numbers. Surfaced by the panel — a silently short bar is a bug report.
   */
  skipped: number;
  /** Set when the spec cannot be plotted at all (e.g. a channel maps to nothing). */
  error?: string | undefined;
}

const EMPTY_FRAME: VizFrame = { categories: [], series: [], rowCount: 0, truncated: false, skipped: 0 };

function emptyFrame(over: Partial<VizFrame> = {}): VizFrame {
  return { ...EMPTY_FRAME, categories: [], series: [], ...over };
}

/** Is this value "no value at all" for grouping purposes? */
function isBlank(v: unknown): boolean {
  return v === null || v === undefined || (typeof v === 'string' && v.trim() === '');
}

/**
 * A number, or null. Deliberately strict: `''` and `'n/a'` are not zero, and a
 * boolean is not 1 — a caller wanting counts asks for `count`.
 */
function asNumber(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') {
    const t = v.trim();
    if (t === '') return null;
    const n = Number(t);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Start of the bucket a date falls in, as a stable sortable label. */
export function binDate(value: unknown, unit: VizBinUnit): string | null {
  const raw = typeof value === 'string' || typeof value === 'number' ? value : null;
  if (raw === null) return null;
  // A date-only string is a wall clock, not an instant: parsing it through Date
  // treats it as midnight UTC and lands on the previous day west of Greenwich.
  const dateOnly = typeof raw === 'string' ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw) : null;
  let y: number;
  let m: number;
  let d: number;
  if (dateOnly) {
    y = Number(dateOnly[1]);
    m = Number(dateOnly[2]) - 1;
    d = Number(dateOnly[3]);
  } else {
    const parsed = new Date(raw);
    if (Number.isNaN(parsed.getTime())) return null;
    y = parsed.getFullYear();
    m = parsed.getMonth();
    d = parsed.getDate();
  }
  const p2 = (n: number): string => String(n).padStart(2, '0');
  switch (unit) {
    case 'year':
      return String(y);
    case 'quarter':
      return `${y}-Q${Math.floor(m / 3) + 1}`;
    case 'month':
      return `${y}-${p2(m + 1)}`;
    case 'week': {
      // ISO week: Thursday of the current week decides the year.
      const dt = new Date(Date.UTC(y, m, d));
      const dow = dt.getUTCDay() || 7;
      dt.setUTCDate(dt.getUTCDate() + 4 - dow);
      const yearStart = Date.UTC(dt.getUTCFullYear(), 0, 1);
      const week = Math.ceil(((dt.getTime() - yearStart) / 86400000 + 1) / 7);
      return `${dt.getUTCFullYear()}-W${p2(week)}`;
    }
    case 'day':
    default:
      return `${y}-${p2(m + 1)}-${p2(d)}`;
  }
}

/** The bucket a number falls in, labelled by its half-open range. */
export function binNumber(value: unknown, width: number): { key: number; label: string } | null {
  const n = asNumber(value);
  if (n === null || !(width > 0)) return null;
  const start = Math.floor(n / width) * width;
  // Trim float noise: 0.1-wide bins otherwise label as 0.30000000000000004.
  const round = (v: number): number => Number(v.toPrecision(12));
  return { key: round(start), label: `${round(start)}–${round(start + width)}` };
}

/**
 * The values a row contributes on one channel. Normally one; an `array` column
 * contributes one per MEMBER, so a chart of a tags column counts per tag the way
 * the grid's filter already matches per tag.
 */
function groupValuesOf(row: Row, field: string, col: ColumnSpec | undefined): unknown[] {
  const raw = row.data[field];
  if (col?.type === 'array' || Array.isArray(raw)) {
    const members = arrayMembers(raw);
    // No members is "no members" — an empty list is an empty category, not absent.
    return members.length > 0 ? members : [null];
  }
  return [raw];
}

function measure(fn: VizMeasureFn, values: unknown[]): { value: number | null; skipped: number } {
  if (fn === 'count') return { value: values.length, skipped: 0 };
  if (fn === 'countDistinct') {
    const seen = new Set(values.map((v) => (isBlank(v) ? '' : String(v))));
    return { value: seen.size, skipped: 0 };
  }
  const nums: number[] = [];
  let skipped = 0;
  for (const v of values) {
    // A blank is absent, not unreadable — it is not "skipped" in the sense the
    // pane warns about, it simply does not contribute.
    if (isBlank(v)) continue;
    const n = asNumber(v);
    if (n === null) skipped++;
    else nums.push(n);
  }
  if (nums.length === 0) return { value: null, skipped };
  switch (fn) {
    case 'sum':
      return { value: nums.reduce((a, b) => a + b, 0), skipped };
    case 'avg':
      return { value: nums.reduce((a, b) => a + b, 0) / nums.length, skipped };
    case 'min':
      return { value: Math.min(...nums), skipped };
    case 'max':
      return { value: Math.max(...nums), skipped };
    default:
      return { value: null, skipped };
  }
}

function measureLabel(fn: VizMeasureFn, columnLabel: string): string {
  if (fn === 'count') return 'Count';
  if (fn === 'countDistinct') return `Distinct ${columnLabel}`;
  const verb = { sum: 'Sum', avg: 'Average', min: 'Min', max: 'Max' }[fn];
  return `${verb} of ${columnLabel}`;
}

interface Bucket {
  key: string;
  labels: string[];
  values: unknown[];
  /** Per measure index, the raw values contributed by this bucket's rows. */
  measured: unknown[][];
  /** Sort key for a binned/typed first group column. */
  sortValue: unknown;
}

/**
 * Collapse rows into a plottable frame.
 *
 * `mapping` is channel key → column field (`ViewInstance.mapping`). A channel
 * whose field no column carries yields an `error` frame rather than an empty
 * chart, because "no data" and "you renamed the column" look identical otherwise
 * and only one of them is the user's fault.
 */
export function aggregateRows(
  rows: readonly Row[],
  columns: readonly ColumnSpec[],
  mapping: Record<string, string>,
  spec: VizAggregate,
  opts: { truncated?: boolean | undefined } = {},
): VizFrame {
  const truncated = opts.truncated === true;
  const byField = new Map(columns.map((c) => [c.field, c]));
  const measures = spec.measures ?? [];
  const groupBy = spec.groupBy ?? [];

  // Resolve every channel this spec reads before touching a row, so a broken
  // mapping is one clear message rather than an empty chart.
  const missing: string[] = [];
  for (const ch of groupBy) {
    const f = mapping[ch];
    if (!f || !byField.has(f)) missing.push(ch);
  }
  for (const m of measures) {
    if (m.fn === 'count') continue; // counts rows, needs no column
    const f = mapping[m.channel];
    if (!f || !byField.has(f)) missing.push(m.channel);
  }
  if (missing.length > 0) {
    const uniq = [...new Set(missing)];
    return emptyFrame({
      truncated,
      rowCount: rows.length,
      error: `No column mapped for ${uniq.length > 1 ? 'channels' : 'channel'} ${uniq.join(', ')}.`,
    });
  }
  if (measures.length === 0) return emptyFrame({ truncated, rowCount: rows.length, error: 'No measure configured.' });

  const binChannel = spec.bin?.channel;
  const binWidth = spec.bin?.width;
  const binUnit = spec.bin?.unit;

  const buckets = new Map<string, Bucket>();
  let skipped = 0;

  for (const row of rows) {
    // One row can land in several buckets when a group channel is an array
    // column — the cross-product of each channel's contributed values.
    let combos: Array<{ values: unknown[]; labels: string[]; sortValue: unknown }> = [{ values: [], labels: [], sortValue: undefined }];
    for (const ch of groupBy) {
      const field = mapping[ch] as string;
      const col = byField.get(field);
      const contributed = groupValuesOf(row, field, col);
      const next: typeof combos = [];
      for (const base of combos) {
        for (const raw of contributed) {
          let label: string;
          let sortValue: unknown = raw;
          if (binChannel === ch) {
            if (binUnit) {
              const b = binDate(raw, binUnit);
              if (b === null) {
                label = EMPTY_LABEL;
                sortValue = null;
              } else {
                label = b;
                sortValue = b;
              }
            } else if (binWidth) {
              const b = binNumber(raw, binWidth);
              if (b === null) {
                label = EMPTY_LABEL;
                sortValue = null;
              } else {
                label = b.label;
                sortValue = b.key;
              }
            } else {
              label = isBlank(raw) ? EMPTY_LABEL : String(raw);
            }
          } else {
            label = isBlank(raw) ? EMPTY_LABEL : String(raw);
          }
          next.push({
            values: [...base.values, raw],
            labels: [...base.labels, label],
            sortValue: base.labels.length === 0 ? sortValue : base.sortValue,
          });
        }
      }
      combos = next;
    }

    for (const combo of combos) {
      const key = combo.labels.join('  ');
      let bucket = buckets.get(key);
      if (!bucket) {
        bucket = {
          key,
          labels: combo.labels,
          values: combo.values,
          measured: measures.map(() => []),
          sortValue: combo.sortValue,
        };
        buckets.set(key, bucket);
      }
      measures.forEach((m, i) => {
        if (m.fn === 'count') {
          (bucket as Bucket).measured[i]?.push(1);
          return;
        }
        const field = mapping[m.channel] as string;
        const col = byField.get(field);
        const vals = col?.type === 'array' || Array.isArray(row.data[field]) ? arrayMembers(row.data[field]) : [row.data[field]];
        for (const v of vals) (bucket as Bucket).measured[i]?.push(v);
      });
    }
  }

  const list = [...buckets.values()];

  // Evaluate measures before ordering: `topN` and value-sort both rank on the
  // first measure, so it has to exist first.
  const evaluated = list.map((b) => {
    const points = measures.map((m, i) => {
      const r = measure(m.fn, b.measured[i] ?? []);
      skipped += r.skipped;
      return r.value;
    });
    return { bucket: b, points };
  });

  const primary = (e: { points: Array<number | null> }): number => e.points[0] ?? Number.NEGATIVE_INFINITY;

  const firstGroupType = groupBy.length > 0 ? byField.get(mapping[groupBy[0] as string] as string)?.type : undefined;
  const sortMode = spec.sort ?? 'category';
  if (sortMode === 'value') evaluated.sort((a, b) => primary(a) - primary(b));
  else if (sortMode === 'valueDesc') evaluated.sort((a, b) => primary(b) - primary(a));
  else {
    evaluated.sort((a, b) => {
      const av = a.bucket.sortValue;
      const bv = b.bucket.sortValue;
      // Empties last in category order — they are a category, but not one worth
      // leading with.
      const aBlank = isBlank(av);
      const bBlank = isBlank(bv);
      if (aBlank !== bBlank) return aBlank ? 1 : -1;
      if (aBlank && bBlank) return 0;
      // A binned key sorts as its own label/number; otherwise by column type.
      if (spec.bin && spec.bin.channel === groupBy[0]) {
        if (typeof av === 'number' && typeof bv === 'number') return av - bv;
        return String(av).localeCompare(String(bv));
      }
      return compareValues(av, bv, firstGroupType ?? 'string');
    });
  }

  let categories: VizCategory[] = evaluated.map((e) => ({
    key: e.bucket.key,
    label: e.bucket.labels.join(' · '),
    values: e.bucket.values,
  }));
  let points: Array<Array<number | null>> = evaluated.map((e) => e.points);

  // topN folds the tail into one bar instead of hiding it. Ranked on the first
  // measure regardless of display order, so "top 5" means top 5 by size even
  // when the chart is sorted by category.
  const topN = spec.topN;
  if (topN && topN > 0 && categories.length > topN) {
    const ranked = [...evaluated].sort((a, b) => primary(b) - primary(a));
    const keep = new Set(ranked.slice(0, topN).map((e) => e.bucket.key));
    const kept: VizCategory[] = [];
    const keptPoints: Array<Array<number | null>> = [];
    const tail: Array<Array<number | null>> = [];
    categories.forEach((c, i) => {
      if (keep.has(c.key)) {
        kept.push(c);
        keptPoints.push(points[i] ?? []);
      } else {
        tail.push(points[i] ?? []);
      }
    });
    if (tail.length > 0) {
      kept.push({ key: OTHER_LABEL, label: OTHER_LABEL, values: [] });
      keptPoints.push(
        measures.map((m, mi) => {
          const vals = tail.map((p) => p[mi]).filter((v): v is number => v !== null && v !== undefined);
          if (vals.length === 0) return null;
          // min/max fold as themselves; everything else as a sum, because the
          // average of averages is not the average.
          if (m.fn === 'min') return Math.min(...vals);
          if (m.fn === 'max') return Math.max(...vals);
          return vals.reduce((a, b) => a + b, 0);
        }),
      );
    }
    categories = kept;
    points = keptPoints;
  }

  const series: VizSeries[] = measures.map((m, i) => {
    const field = mapping[m.channel];
    const label = field ? (byField.get(field)?.label ?? field) : (m.channel ?? 'Value');
    return {
      key: `${m.channel}:${m.fn}`,
      label: measureLabel(m.fn, label),
      points: points.map((p) => p[i] ?? null),
    };
  });

  return { categories, series, rowCount: rows.length, truncated, skipped };
}
