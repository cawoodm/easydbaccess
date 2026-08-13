// packages/renderer/src/plugins/viz-map.ts
//
// The `map` visualization kind: lat/lon points on raster tiles.
//
// Its own plugin rather than part of `viz-charts` because it carries its own
// library (Leaflet) and its own network dependency (tiles). A user who wants bar
// charts and no mapping should be able to switch exactly this off, and a
// deployment with no internet has a reason to.
//
// `data: 'rows'` — a map plots one marker per row, so there is nothing to
// aggregate. That is the whole reason `VisualizationSpec.data` exists.

import type { HostApi } from '@easydb/shared';

export const meta = {
  id: 'viz-map',
  name: 'Map',
  type: 'ui' as const,
  version: '0.1.0',
  description: 'Plot rows with latitude/longitude columns as points on a map.',
  icon: 'public',
};

export function init(api: HostApi): void {
  api.ui.registerVisualization({
    id: 'map',
    label: 'Map',
    icon: 'public',
    tag: 'viz-point-map',
    channels: [
      // Restricted to `number`: a lat/lon that is not numeric is not a
      // coordinate, and offering a text column here only produces an empty map.
      { key: 'LAT', label: 'Latitude', kind: 'lat', accepts: ['number'], required: true },
      { key: 'LON', label: 'Longitude', kind: 'lon', accepts: ['number'], required: true },
      { key: 'LABEL', label: 'Tooltip label (optional)', kind: 'text' },
      { key: 'WEIGHT', label: 'Size by (optional)', kind: 'weight', accepts: ['number'] },
    ],
    data: 'rows',
    options: [
      { key: 'radius', label: 'Marker size (px)', type: 'number', default: 6 },
      { key: 'scaleByWeight', label: 'Scale markers by the size column', type: 'boolean' },
      {
        key: 'tileUrl',
        label: 'Tile URL template',
        type: 'string',
        description: 'Leave blank to use the Settings → Visualizations default.',
      },
    ],
  });
}
