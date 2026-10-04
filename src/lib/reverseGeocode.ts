/**
 * Reverse-geocode lat/lng to a human-readable address via OpenStreetMap
 * Nominatim (free, no API key). Respects Nominatim usage policy: max 1 req/sec,
 * descriptive User-Agent (via Referer in browser), and a sensible timeout.
 */
export interface ReverseGeocodeResult {
  address: string;
  raw?: unknown;
}

export async function reverseGeocode(
  lat: number,
  lng: number,
  signal?: AbortSignal
): Promise<ReverseGeocodeResult | null> {
  try {
    const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lng}&zoom=18&addressdetails=1`;
    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), 8000);
    const res = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: signal ?? ctrl.signal,
    });
    clearTimeout(timeout);
    if (!res.ok) return null;
    const data = (await res.json()) as { display_name?: string; address?: Record<string, string> };
    if (!data) return null;

    const a = data.address || {};
    // Build a Uganda-friendly short address: "Road, Suburb, City"
    const parts = [
      a.house_number && a.road ? `${a.house_number} ${a.road}` : a.road,
      a.neighbourhood || a.suburb || a.village || a.hamlet,
      a.city || a.town || a.county,
    ].filter(Boolean);
    const short = parts.join(', ');
    const address = short || data.display_name || '';
    if (!address) return null;
    return { address, raw: data };
  } catch {
    return null;
  }
}
