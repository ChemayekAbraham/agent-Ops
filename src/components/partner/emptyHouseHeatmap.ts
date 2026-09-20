/**
 * Africa-wide empty-house density heatmap helpers.
 *
 * The heatmap reuses the viewport cells the map already fetches (each cell
 * carries how many empty houses sit inside it), so switching it on costs no
 * extra database work. Colours are bucketed rather than continuous so the
 * legend stays readable on a phone.
 */

export interface HeatBucket {
  /** Lowest house count that falls in this bucket. */
  from: number;
  label: string;
  color: string;
  opacity: number;
}

/** Warm scale: few houses → cool, many houses → hot. */
export const HEAT_BUCKETS: HeatBucket[] = [
  { from: 1, label: '1 – 9', color: '#38bdf8', opacity: 0.25 },
  { from: 10, label: '10 – 49', color: '#4ade80', opacity: 0.3 },
  { from: 50, label: '50 – 199', color: '#facc15', opacity: 0.35 },
  { from: 200, label: '200 – 999', color: '#fb923c', opacity: 0.4 },
  { from: 1000, label: '1,000+', color: '#ef4444', opacity: 0.45 },
];

export function heatBucketFor(count: number): HeatBucket {
  let bucket = HEAT_BUCKETS[0];
  for (const candidate of HEAT_BUCKETS) {
    if (count >= candidate.from) bucket = candidate;
  }
  return bucket;
}

/**
 * Zoom level at which individual rent pins take over from the density view.
 * Above this the funder is browsing houses, not regions.
 */
export const HEATMAP_MAX_ZOOM = 12;

export const heatmapAppliesAtZoom = (zoom: number | null | undefined) =>
  typeof zoom === 'number' && zoom <= HEATMAP_MAX_ZOOM;
