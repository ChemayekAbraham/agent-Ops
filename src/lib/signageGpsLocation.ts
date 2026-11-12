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
  const village = (a.village || a.hamlet || a.neighbourhood || a.suburb || a.quarter || a.town || a.city || '').trim();
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