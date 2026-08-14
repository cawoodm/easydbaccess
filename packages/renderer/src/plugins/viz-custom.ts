// packages/renderer/src/plugins/viz-custom.ts
//
// The `custom` visualization kind: a block of the user's own HTML, drawn over
// whatever rows the pane was given.
//
// The one visualization with `channels: []`. Every other kind asks which column
// is the category and which is the value; this one takes the whole set, and the
// markup names its columns itself (`$SUM.amount`, `$filter.country`) — so a
// mapping dialog would have nothing to ask about. See `viz/viz-tokens.ts` for
// the vocabulary and `viz/viz-custom-html.ts` for the element.

import type { HostApi } from '@easydb/shared';

export const meta = {
  id: 'viz-custom',
  name: 'Custom HTML',
  type: 'ui' as const,
  version: '0.1.0',
  description: 'Draw a table with your own HTML — a KPI tile, a row of filter pills, a summary line.',
  icon: 'code',
};

export function init(api: HostApi): void {
  api.ui.registerVisualization({
    id: 'custom',
    label: 'Custom HTML',
    icon: 'code',
    tag: 'viz-custom-html',
    // Nothing to map: the markup names the columns it reads.
    channels: [],
    data: 'rows',
    // It draws its own chrome, so the pane's inset would be a second margin.
    bleed: true,
    options: [
      {
        key: 'html',
        label: 'HTML',
        type: 'text',
        code: 'html',
        description: 'Your markup. $COUNT, $SUM.field, $AVG.field, $MIN.field, $MAX.field, $DISTINCT.field and $filter.field are replaced.',
        help:
          'Tokens describe the WHOLE set the pane was given, not one row — $COUNT is how many rows are on screen, ' +
          '$SUM.amount is their total. $filter.country renders one clickable pill per distinct value; clicking one ' +
          'narrows the grid this pane is docked to. Anything that is not a token is left exactly as you wrote it.',
      },
      {
        key: 'script',
        label: 'Script',
        type: 'text',
        code: 'javascript',
        description: 'Optional. function render(rows, api) — return a string, or write into api.el.',
        help:
          'Runs once per draw, after the HTML is in place. `rows` is what the grid is showing; `api.el` is the ' +
          'container, `api.columns` the column specs, and `api.filter(field, value)` / `api.sort(field)` ask the ' +
          'host grid to change. Return a string to replace the container’s markup, or return nothing and write ' +
          'into `api.el` yourself.',
      },
    ],
  });
}
