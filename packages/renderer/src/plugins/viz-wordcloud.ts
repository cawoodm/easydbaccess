// packages/renderer/src/plugins/viz-wordcloud.ts
//
// The `wordcloud` visualization kind: term frequency over a text column.
//
// Its own plugin for the same reason `viz-map` is: it carries its own library
// (`d3-cloud`) and is the kind most likely to be unwanted. `data: 'rows'` —
// the counting is a tokenization pass over cells, not a group-by, and it lives in
// the pure `viz/word-frequency.ts`.

import type { HostApi } from '@easydb/shared';

export const meta = {
  id: 'viz-wordcloud',
  name: 'Word cloud',
  type: 'ui' as const,
  version: '0.1.0',
  description: 'Show the most frequent words in a text column, sized by how often they occur.',
  icon: 'cloud',
};

export function init(api: HostApi): void {
  api.ui.registerVisualization({
    id: 'wordcloud',
    label: 'Word cloud',
    icon: 'cloud',
    tag: 'viz-word-cloud',
    channels: [
      {
        key: 'TEXT',
        label: 'Text column',
        kind: 'text',
        required: true,
        // Any type: an `array` (tags) column makes an excellent cloud, and a
        // number column is legitimate once `includeNumbers` is on.
      },
    ],
    data: 'rows',
    options: [
      { key: 'minLength', label: 'Ignore words shorter than', type: 'number', default: 3 },
      {
        key: 'keepWords',
        label: 'Always keep these words',
        type: 'text',
        description: 'The exception to the limit above, and to the ignore list below. Commas, spaces or new lines.',
      },
      {
        key: 'stopWords',
        label: 'Ignore these common words',
        type: 'text',
        description: 'Clear it to count every word. Commas, spaces or new lines.',
      },
      { key: 'maxTerms', label: 'Most words to show', type: 'number', default: 120 },
      { key: 'includeNumbers', label: 'Include numbers', type: 'boolean' },
      { key: 'rotate', label: 'Allow sideways words', type: 'boolean' },
    ],
  });
}
