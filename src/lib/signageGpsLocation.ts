import type { ReverseGeocodeResult } from './reverseGeocode';

export interface SignageGpsLocation {
  district: string;
  county: string;
  subcounty: string;
  parish: string;
  village: string;
  address: string;
}

/** Only address components returned for this GPS point; missing levels stay blank. */
export function signageGpsLocation(result: ReverseGeocodeResult | null): SignageGpsLocation | null {
  const raw = result?.raw as { address?: Record<string, string> } | undefined;
  const a = raw?.address;
  if (!result || !a || a.country_code?.toLowerCase() !== 'ug') return null;
  // Nominatim identifies Uganda districts in county; do not substitute regions/states.
  const district = (a.district || a.county || '').trim();
  const village = (a.village || a.hamlet || a.neighbourhood || a.suburb || a.quarter || a.town || a.city || a.locality || a.city_district || a.road || '').trim();
  if (!district || !village) return null;
  return {
    district,
    county: a.district ? a.county || '' : '',
    subcounty: a.subcounty || a.sub_county || '',
    parish: a.parish || '',
    village,
    address: result.address,
  };
}
export type SignageLookupOutcome =
  | { kind: 'ok'; location: SignageGpsLocation }
  | { kind: 'unresolved' }
  | { kind: 'connection' };

interface BigDataCloudResponse {
  countryCode?: string;
  city?: string;
  locality?: string;
  localityInfo?: { administrative?: { name?: string }[] };
}

/** Maps the backup geocoder's response to the same address shape; district only from a named "District" entry. */
export function bigDataCloudToReverse(data: BigDataCloudResponse | null): ReverseGeocodeResult | null {
  if (!data) return null;
  const districtEntry = (data.localityInfo?.administrative || []).find((x) => /\bdistrict\b/i.test(x.name || ''));
  const district = (districtEntry?.name || '').replace(/\s*district\s*$/i, '').trim();
  const locality = (data.locality || data.city || '').trim();
  const address = [locality, district].filter(Boolean).join(', ');
  return {
    address: address || 'Uganda',
    raw: { address: { country_code: (data.countryCode || '').toLowerCase(), county: district, locality } },
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
    if (loc) return { kind: 'ok', location: loc };
  } catch { /* fall through to backup */ }
  try {
    const data = (await fetchJson(
      `https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat}&longitude=${lng}&localityLanguage=en`,
    )) as BigDataCloudResponse;
    reached = true;
    const loc = signageGpsLocation(bigDataCloudToReverse(data));
    if (loc) return { kind: 'ok', location: loc };
  } catch { /* both failed */ }
  return reached ? { kind: 'unresolved' } : { kind: 'connection' };
}
