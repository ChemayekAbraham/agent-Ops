/**
 * Pure presentation rules for empty-house map clusters.
 *
 * Kept outside the map component so the load tests can assert them against a
 * simulated 10,000,000+ house catalogue without mounting Leaflet.
 */

/** Pixel diameter of a cluster badge for a given house count. */
export const clusterMarkerSize = (count: number) => (count >= 1000 ? 58 : count >= 100 ? 50 : 42);

/** Badge label: compact thousands above 1,000, exact count below. */
export const clusterMarkerLabel = (count: number) =>
  count >= 1000 ? `${Math.round(count / 1000)}k+` : count.toLocaleString();

/** Zoom a cluster tap should fly to (never past the max map zoom). */
export const clusterZoomTarget = (currentZoom: number) => Math.min(currentZoom + 3, 18);
