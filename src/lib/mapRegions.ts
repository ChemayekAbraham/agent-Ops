/**
 * Coarse region labels for map telemetry, so production monitoring can show
 * which parts of Africa are slow. Deliberately low-cardinality: a handful of
 * buckets, never per-user or per-coordinate detail.
 */
export function mapRegionFor(lat: number | null | undefined, lng: number | null | undefined): string {
  if (lat == null || lng == null || Number.isNaN(lat) || Number.isNaN(lng)) return 'unknown';

  const inAfrica = lat >= -35 && lat <= 38 && lng >= -20 && lng <= 52;
  if (!inAfrica) return 'outside-africa';

  if (lat > 16) return 'north-africa';
  if (lat < -12) return 'southern-africa';
  if (lng < 10) return 'west-africa';
  if (lng < 24) return 'central-africa';
  if (lat >= -1.6 && lat <= 4.4 && lng >= 29.4 && lng <= 35.1) return 'uganda';
  return 'east-africa';
}
