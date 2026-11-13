import type { ReverseGeocodeResult } from './reverseGeocode';
import { areaHints, districtHints, flattenChain, mergeOfficialChain, villageHints, type OfficialCandidates } from './signageOfficialLocation';

export interface SignageGpsLocation {
  district: string;
  county: string;
  subcounty: string;
  parish: string;
  village: string;
  address: string;
  /** True when a real locality name came back; a road-only fallback does not count. */
  villageFound: boolean;
  /** True when a street/road name came back for the plot/landmark line. */
  landmarkFound: boolean;
}

const LOCALITY_KEYS = [
  'village', 'hamlet', 'neighbourhood', 'suburb', 'quarter',
  'town', 'city', 'locality', 'city_district',
] as const;

/**
 * Where the district-level name can sit in an OpenStreetMap address. Ugandan cities
 * (Entebbe City, Kampala, Mbarara City...) are district-level and come back with no
 * district/county at all, only `city` + `city_district` (the division). Never `state`:
 * that is the region.
 */
const DISTRICT_KEYS = ['district', 'state_district', 'county', 'city', 'town'] as const;

/** Only address components returned for this GPS point; missing levels stay blank. */
export function signageGpsLocation(result: ReverseGeocodeResult | null): SignageGpsLocation | null {
  const raw = result?.raw as { address?: Record<string, string> } | undefined;
  const a = raw?.address;
  if (!result || !a || a.country_code?.toLowerCase() !== 'ug') return null;
  const districtKey = DISTRICT_KEYS.find((k) => (a[k] || '').trim());
  if (!districtKey) return null;
  const districtRaw = a[districtKey].trim();
  const district = districtRaw.replace(/\s+district$/i, '').trim();
  const isCity = districtKey === 'city' || districtKey === 'town';
  // A locality equal to the district (e.g. city "Entebbe" for district "Entebbe") is not a village.
  const locality = LOCALITY_KEYS.map((k) => (a[k] || '').trim())
    .find((v) => v && v !== districtRaw && v !== district) || '';
  const road = (a.road || '').trim();
  // Best available name for the Village / Locality line: a real locality, else the road.
  const village = locality || road;
  return {
    district,
    county: districtKey === 'district' || districtKey === 'state_district' ? a.county || '' : '',
    // In a city the division (city_district) is the sub-county level.
    subcounty: a.subcounty || a.sub_county || (isCity ? (a.city_district || '').trim() : ''),
    parish: a.parish || '',
    village,
    address: result.address,
    villageFound: !!locality,
    landmarkFound: !!road,
  };
}

/** The village actually saved: the GPS name when the lookup found one, otherwise what the agent typed. */
export function resolvedSignageVillage(location: SignageGpsLocation | null, typed: string): string {
  if (!location) return '';
  return location.villageFound ? location.village : typed.trim();
}

export type SignageLookupOutcome =
  | { kind: 'ok'; location: SignageGpsLocation }
  | { kind: 'unresolved' }
  | { kind: 'connection' };

interface BigDataCloudAdmin { name?: string; description?: string; adminLevel?: number }
interface BigDataCloudResponse {
  countryCode?: string;
  /** For Uganda this is the region (e.g. "Central"), never the district: do not use it. */
  principalSubdivision?: string;
  city?: string;
  locality?: string;
  localityInfo?: { administrative?: BigDataCloudAdmin[] };
}

const isCountryOrRegion = (x: BigDataCloudAdmin) =>
  (x.adminLevel !== undefined && x.adminLevel <= 3) || /\b(region|country)\b/i.test(`${x.name} ${x.description}`);

/**
 * Maps the backup geocoder's response to the same address shape. District: an entry named or
 * described as a district, else one described as a city, else the first entry below region level.
 * The entry after it (e.g. "Kasenyi") is the division / sub-county.
 */
export function bigDataCloudToReverse(data: BigDataCloudResponse | null): ReverseGeocodeResult | null {
  if (!data) return null;
  const admin = (data.localityInfo?.administrative || []).filter((x) => (x.name || '').trim());
  const text = (x: BigDataCloudAdmin) => `${x.name} ${x.description || ''}`;
  let idx = admin.findIndex((x) => /\bdistrict\b/i.test(text(x)));
  let isCity = false;
  if (idx < 0) { idx = admin.findIndex((x) => /\bcity\b/i.test(x.description || '')); isCity = idx >= 0; }
  if (idx < 0) idx = admin.findIndex((x) => !isCountryOrRegion(x) && (x.adminLevel ?? 4) >= 4);
  const district = idx >= 0 ? (admin[idx].name || '').replace(/\s*district\s*$/i, '').trim() : '';
  const division = idx >= 0 ? (admin[idx + 1]?.name || '').trim() : '';
  const locality = (data.locality || data.city || '').trim();
  const address = [locality !== district ? locality : '', division, district].filter(Boolean).join(', ');
  return {
    address: address || 'Uganda',
    raw: { address: {
      country_code: (data.countryCode || '').toLowerCase(),
      [isCity ? 'city' : 'county']: district,
      city_district: division,
      locality,
    } },
  };
}

async function fetchJson(url: string, ms = 8000): Promise<unknown> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { headers: { Accept: 'application/json' }, signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

/** ilike pattern that tolerates quotes/punctuation differences ("Bendegere 'A'" vs "Bendegere A"). */
const likePattern = (s: string) => s.trim().replace(/[^A-Za-z0-9]+/g, '%');
const OFFICIAL_CHAIN = 'name, subcounty:ug_subcounties(name, county:ug_counties(name, district:ug_districts(name)))';

/** Official dataset rows whose names match what the geocoder returned. Empty on any error. */
async function fetchOfficialCandidates(a: Record<string, string>): Promise<OfficialCandidates> {
  const empty: OfficialCandidates = { villages: [], parishes: [], counties: [] };
  const orIlike = (names: string[], wrap = (x: string) => x) =>
    names.map(likePattern).filter((x) => x.replace(/%/g, '').length >= 3).map((x) => `name.ilike.${wrap(x)}`).join(',');
  const v = orIlike(villageHints(a));
  const p = orIlike(areaHints(a));
  // Municipality structure: "Entebbe City" → county "Entebbe Municipality".
  const d = orIlike(districtHints(a).map((x) => x.replace(/\b(city|municipality|district)\b/gi, '')), (x) => `%${x}%`);
  try {
    const { supabase } = await import('@/integrations/supabase/client');
    const db = supabase as any;
    const [villages, parishes, counties] = await Promise.all([
      v ? db.from('ug_villages').select(`name, parish:ug_parishes(${OFFICIAL_CHAIN})`).or(v).limit(50) : { data: [] },
      p ? db.from('ug_parishes').select(OFFICIAL_CHAIN).or(p).limit(50) : { data: [] },
      d ? db.from('ug_counties').select('name, district:ug_districts(name)').or(d).limit(20) : { data: [] },
    ]);
    return {
      villages: (villages.data ?? []).map((r: unknown) => flattenChain(r, 'village')),
      parishes: (parishes.data ?? []).map((r: unknown) => flattenChain(r, 'parish')),
      counties: (counties.data ?? []).map((r: unknown) => flattenChain(r, 'county')),
    };
  } catch {
    return empty;
  }
}

/** Adds County / Sub-County / Parish from the official dataset; never blocks or breaks the GPS result. */
async function withOfficialChain(loc: SignageGpsLocation, a: Record<string, string>): Promise<SignageGpsLocation> {
  try {
    const timeout = new Promise<null>((r) => setTimeout(() => r(null), 6000));
    const c = await Promise.race([fetchOfficialCandidates(a), timeout]);
    return c ? mergeOfficialChain(loc, a, c) : loc;
  } catch {
    return loc;
  }
}

/** Primary geocoder (OpenStreetMap), then backup geocoder; reports connection failures separately. */
export async function lookupSignageGpsLocation(lat: number, lng: number): Promise<SignageLookupOutcome> {
  let reached = false;
  try {
    const data = (await fetchJson(
      `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lng}&zoom=18&addressdetails=1`,
    )) as { display_name?: string; address?: Record<string, string> };
    reached = true;
    const a = data?.address || {};
    const short = [a.road, a.neighbourhood || a.suburb || a.village || a.hamlet, a.city || a.town || a.county]
      .filter(Boolean).join(', ');
    const loc = signageGpsLocation({ address: short || data?.display_name || 'Uganda', raw: data });
    if (loc) return { kind: 'ok', location: await withOfficialChain(loc, a) };
  } catch { /* fall through to backup */ }
  try {
    const data = (await fetchJson(
      `https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat}&longitude=${lng}&localityLanguage=en`,
    )) as BigDataCloudResponse;
    reached = true;
    const reverse = bigDataCloudToReverse(data);
    const loc = signageGpsLocation(reverse);
    const a = ((reverse?.raw as { address?: Record<string, string> } | undefined)?.address) || {};
    if (loc) return { kind: 'ok', location: await withOfficialChain(loc, a) };
  } catch { /* both failed */ }
  return reached ? { kind: 'unresolved' } : { kind: 'connection' };
}
