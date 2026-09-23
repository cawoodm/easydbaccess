import { css, html, type TemplateResult } from 'lit';
import { state } from 'lit/decorators.js';
import type { FilterPickerContext, FilterPickerResult, HostApi, PluginModule } from '@easydb/shared';
import { composeRange, readRange, type FilterRange } from '@easydb/shared';
import { FilterPickerShell } from '../chrome/filter-picker-shell.js';
import { DEFAULT_DATE_PRESETS, parseDatePresets, type DatePreset } from './date-presets.js';

export const meta: NonNullable<PluginModule['meta']> = {
  id: 'date-filter',
  name: 'Date Filter',
  type: 'ui',
  version: '0.1.0',
  description:
    'A date-shaped funnel dropdown for date columns: named presets ("Last 3 ' +
    'months", "Year to date") and a from/to range, instead of the list of ' +
    'distinct values. The ← button goes back to that list. Presets are ' +
    'configurable in Settings → Dates.',
  author: 'Marc Cawood',
  icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>',
  repo: 'https://github.com/cawoodm/easydbaccess/blob/main/packages/renderer/src/plugins/date-filter.ts',
};

const PRESETS_KEY = 'presets';

export function init(api: HostApi): void {
  if (!customElements.get('date-filter-popover')) customElements.define('date-filter-popover', DateFilterPopover);
  // Registered under both the TYPE and the RENDERER name. The host looks the
  // renderer up first, so a `string` column whose renderer is `date` — which is
  // how `cell-date` says to apply it — gets this panel too.
  api.ui.registerFilterPicker('date', 'date-filter-popover');
  api.ui.registerFilterPicker('datetime', 'date-filter-popover');
  api.ui.registerSettings(meta.id, 'Dates', [
    {
      key: PRESETS_KEY,
      label: 'Funnel presets for date columns',
      type: 'string',
      default: DEFAULT_DATE_PRESETS,
      scope: 'user',
      description: 'Comma-separated. 3m = Last 3 months, 1y = Past year, y = Year to date, q/m/w = Quarter/Month/Week to date. Add =Your label to rename one, e.g. 3m=Last quarter.',
      help:
        'Units are d (days), w (weeks), m (months) and y (years); a number in front is how many, so 7d is the last seven days and 2y the last two years. ' +
        'A bare y, q, m or w is the period so far — y means 1 January to today. ' +
        'An entry that cannot be read is skipped rather than shown as a broken row. ' +
        'This setting is device-local, so it does not travel inside a shared .edb.',
    },
  ]);
  // Read on every open rather than cached: the popover opens on demand, so
  // there is no hot path to protect and no stale value to invalidate.
  DateFilterPopover.readPresets = async () => {
    const spec = await api.settings.get<string>(meta.id, PRESETS_KEY);
    return parseDatePresets(spec ?? DEFAULT_DATE_PRESETS);
  };
}

/**
 * The funnel dropdown for a date column: presets on top, a from/to range under
 * them, ← back to the ordinary value list.
 *
 * Every change is applied LIVE through `ctx.onChange` and leaves the panel open,
 * which is what the stock value-list popover does and what makes trying two
 * presets in a row cheap.
 *
 * Deliberately NOT decorated with `@customElement`: that defines the element at
 * module scope, which throws if the module is ever evaluated twice. `init`
 * defines it behind a `customElements.get` guard instead, the same way
 * `cell-date.ts` and every other renderer plugin here does.
 */
class DateFilterPopover extends FilterPickerShell {
  /** Set by `init` — the plugin owns the settings read, the element does not. */
  static readPresets: () => Promise<DatePreset[]> = () => Promise.resolve(parseDatePresets(DEFAULT_DATE_PRESETS));

  static override styles = [
    ...FilterPickerShell.filterPickerStyles,
    css`
      ul {
        list-style: none;
        margin: 0;
        padding: 0;
      }
      li {
        padding: 0.3rem 0.55rem;
        cursor: pointer;
        display: flex;
        align-items: center;
        gap: 0.4rem;
      }
      li:hover {
        background: #eff6ff;
      }
      li .dot {
        flex: 0 0 auto;
        width: 6px;
        height: 6px;
        border-radius: 50%;
        background: transparent;
      }
      li.active .dot {
        background: #2563eb;
      }
      li.active {
        font-weight: 600;
      }
      .range {
        border-top: 1px solid #e5e7eb;
        padding: 0.4rem 0.55rem;
        display: grid;
        grid-template-columns: auto 1fr;
        gap: 0.3rem 0.5rem;
        align-items: center;
      }
      .range label {
        color: #6b7280;
      }
      .range input {
        font: inherit;
        padding: 0.2rem 0.3rem;
        border: 1px solid #d1d5db;
        border-radius: 0.2rem;
        width: 100%;
        box-sizing: border-box;
      }
      .empty {
        padding: 0.5rem 0.55rem;
        color: #9ca3af;
        font-style: italic;
      }
    `,
  ];

  @state() private presets: DatePreset[] = [];
  @state() private range: FilterRange = { rest: [] };
  @state() private bounds: { min?: string; max?: string } = {};
  private ctx: FilterPickerContext | null = null;

  open(anchor: DOMRect, ctx: FilterPickerContext): Promise<FilterPickerResult> {
    this.ctx = ctx;
    this.shellTitle = ctx.label;
    this.range = readRange(ctx.current);
    this.bounds = {};
    this.presets = [];
    const opening = this.openShell(anchor);
    // Both reads are deliberately AFTER the popover is on screen: a funnel click
    // has to stay instant, and on a windowed grid the value list may cost a
    // round trip. Each swallows its own failure — a picker that cannot read its
    // presets or the column's span is still a working picker, and an unhandled
    // rejection here would surface as a console error the user cannot act on.
    void DateFilterPopover.readPresets()
      .then((p) => (this.presets = p))
      .catch(() => {
        // Settings unreadable: the panel says "No presets configured" and the
        // from/to boxes still work.
      });
    void ctx
      .values()
      .then(({ values }) => {
        const dates = values.map((v) => v.value.slice(0, 10)).filter((v) => /^\d{4}-\d{2}-\d{2}$/.test(v)).sort();
        // `noUncheckedIndexedAccess` does not narrow through a length check, so
        // the ends are destructured and tested rather than asserted with `!`.
        const [min] = dates;
        const max = dates.at(-1);
        if (min !== undefined && max !== undefined) this.bounds = { min, max };
      })
      .catch(() => {
        // A store that cannot answer just means no min/max hint on the inputs.
      });
    return opening;
  }

  /** Apply a new range, keeping whatever else the filter held. */
  private apply(next: FilterRange): void {
    this.range = next;
    this.ctx?.onChange(composeRange(next));
  }

  private pickPreset(p: DatePreset): void {
    // A preset is a lower bound with no upper one — "the last three months" runs
    // to today and beyond, and clamping the top would hide a future-dated row.
    this.apply({ from: { value: p.term, strict: false }, rest: this.range.rest });
  }

  private setBound(which: 'from' | 'to', value: string): void {
    const next: FilterRange = { ...this.range };
    if (value === '') delete next[which];
    else next[which] = { value, strict: false };
    this.apply(next);
  }

  /** The from/to boxes show a literal date; a relative bound is not one. */
  private boundInput(which: 'from' | 'to'): string {
    const v = this.range[which]?.value ?? '';
    return /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : '';
  }

  private get activeTerm(): string | null {
    // A preset is active only when it is the WHOLE range — a from/to pair that
    // happens to start on the same day is not "Last 3 months".
    if (this.range.to) return null;
    return this.range.from?.value ?? null;
  }

  override render(): TemplateResult {
    const active = this.activeTerm;
    const body = html`
      ${this.presets.length === 0
        ? html`<div class="empty">No presets configured.</div>`
        : html`<ul>
            ${this.presets.map(
              (p) => html`
                <li class=${p.term === active ? 'active' : ''} title=${`Filter to ${p.label.toLowerCase()}`} @click=${() => this.pickPreset(p)}>
                  <span class="dot"></span>
                  <span>${p.label}</span>
                </li>
              `,
            )}
          </ul>`}
      <div class="range">
        <label for="date-filter-from">From</label>
        <input
          id="date-filter-from"
          type="date"
          .value=${this.boundInput('from')}
          min=${this.bounds.min ?? ''}
          max=${this.bounds.max ?? ''}
          @change=${(e: Event) => this.setBound('from', (e.target as HTMLInputElement).value)}
        />
        <label for="date-filter-to">To</label>
        <input
          id="date-filter-to"
          type="date"
          .value=${this.boundInput('to')}
          min=${this.bounds.min ?? ''}
          max=${this.bounds.max ?? ''}
          @change=${(e: Event) => this.setBound('to', (e.target as HTMLInputElement).value)}
        />
      </div>
    `;
    return this.renderShell(this.shellTitle, body);
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'date-filter-popover': DateFilterPopover;
  }
}
