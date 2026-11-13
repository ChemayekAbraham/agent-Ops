/** Only a radius the funder chose limits the list; "Nearest first" orders but never hides. */
export function withinRadius(km: number | null, radiusKm: number | null): boolean {
  if (radiusKm === null) return true;
  return km !== null && km <= radiusKm;
}
