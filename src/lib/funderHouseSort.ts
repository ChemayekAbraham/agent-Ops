/** Completeness is presentation only, never a substitute for approval. */
export const TENANT_PLACEHOLDERS = new Set(['', 'tenant', 'unknown', 'not assigned', 'no tenant', 'pending', 'n/a', 'none', 'null', 'tenant pending', 'unnamed tenant']);
export const LANDLORD_PLACEHOLDERS = new Set(['', 'landlord', 'unknown', 'not assigned', 'no landlord', 'pending', 'n/a', 'none', 'null', 'unnamed landlord']);
export interface FunderHouseCompleteness {
  hasTenant: boolean;
  hasLandlord: boolean;
  hasGps: boolean;
  complete: boolean;
}
type HouseLike = object;
const fields = (house: HouseLike) => house as Record<string, unknown>;
function realName(value: unknown, placeholders: Set<string>): boolean {
  return typeof value === 'string' && !placeholders.has(value.trim().toLowerCase());
}
export function hasFunderTenant(house: HouseLike): boolean {
  const h = fields(house);
  return ['tenant_first_name', 'tenant_full_name', 'tenant_name', 'tenantName'].some(k => realName(h[k], TENANT_PLACEHOLDERS));
}
export function hasFunderLandlord(house: HouseLike): boolean {
  const h = fields(house);
  return ['landlord_name', 'landlordName'].some(k => realName(h[k], LANDLORD_PLACEHOLDERS));
}
function coordinate(value: unknown): number | null {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
export function hasFunderGps(house: HouseLike): boolean {
  const h = fields(house);
  // Choose a pair together; never combine coordinates from different sources.
  return [['request_latitude', 'request_longitude'], ['latitude', 'longitude'], ['lat', 'lng']].some(([a, b]) => {
    const lat = coordinate(h[a]); const lng = coordinate(h[b]);
    return lat !== null && lng !== null && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && (lat !== 0 || lng !== 0);
  });
}
export function getFunderHouseCompleteness(house: HouseLike): FunderHouseCompleteness {
  const hasTenant = hasFunderTenant(house), hasLandlord = hasFunderLandlord(house), hasGps = hasFunderGps(house);
  return { hasTenant, hasLandlord, hasGps, complete: hasTenant && hasLandlord && hasGps };
}
/** Lower rank sorts first. Tenant > landlord > GPS; all three = rank zero. */
export function getFunderHouseCompletenessRank(house: HouseLike): number {
  const c = getFunderHouseCompleteness(house);
  return 7 - (Number(c.hasTenant) * 4 + Number(c.hasLandlord) * 2 + Number(c.hasGps));
}
export function compareFunderHousesByCompleteness(a: HouseLike, b: HouseLike): number {
  return getFunderHouseCompletenessRank(a) - getFunderHouseCompletenessRank(b);
}
export function sortFunderHousesByCompleteness<T extends object>(houses: readonly T[], tieBreaker?: (a: T, b: T) => number): T[] {
  return [...houses].sort((a, b) => compareFunderHousesByCompleteness(a, b) || tieBreaker?.(a, b) || 0);
}
export function sortFunderFeedEntries<T extends { item: object }>(entries: readonly T[]): T[] {
  return [...entries].sort((a, b) => compareFunderHousesByCompleteness(a.item, b.item));
}