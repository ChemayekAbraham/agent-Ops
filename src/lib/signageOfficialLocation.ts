/**
 * Completes a GPS signage location with the official Uganda administrative chain
 * (ug_districts → ug_counties → ug_subcounties → ug_parishes → ug_villages).
 *
 * The geocoders rarely return County or Parish, and in towns they speak the urban
 * structure instead (City/Municipality → Division → Ward → Cell). In the official
 * dataset a municipality is a county (e.g. "Entebbe Municipality" in Wakiso), a
 * division is a sub-county and a ward is a parish. So we match the names the
 * geocoder did return against the dataset and take the levels it is missing.
 *
 * Pure matching only — no network. The caller fetches candidate rows. We never guess:
 * a level is filled only when every remaining candidate agrees on it.
 */
import type { SignageGpsLocation } from './signageGpsLocation';

/** One official chain, flattened. village/parish are null for county-only rows. */
export interface OfficialChainRow {
  village: string | null;
  parish: string | null;
  subcounty: string | null;
  county: string | null;
  district: string | null;
}

export interface OfficialCandidates {
  villages: OfficialChainRow[];
  parishes: OfficialChainRow[];
  counties: OfficialChainRow[];
}

/** Drop structural words so "Entebbe City", "Entebbe Municipality" and "Entebbe" compare equal. */
export function normalizeAdminName(s: string | null | undefined): string {
  return (s || '')
    .toLowerCase()
    .replace(/\b(city|municipality|municipal council|municipal|district|division|town council|tc|ward|cell|village|parish|sub ?county|county)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

const clean = (s: string | null | undefined) => (s || '').trim();

/** Names the geocoder gave for the district / municipality level. */
export function districtHints(a: Record<string, string>): string[] {
  return uniq(['district', 'state_district', 'county', 'municipality', 'city', 'town'].map((k) => clean(a[k])));
}

/** Names the geocoder gave for the division / ward level. */
export function areaHints(a: Record<string, string>): string[] {
  return uniq(['city_district', 'suburb', 'subcounty', 'sub_county', 'parish', 'quarter'].map((k) => clean(a[k])));
}

/** Names the geocoder gave for the village / cell level. */
export function villageHints(a: Record<string, string>): string[] {
  return uniq(['village', 'hamlet', 'neighbourhood', 'suburb', 'quarter', 'residential'].map((k) => clean(a[k])));
}

function uniq(xs: string[]): string[] {
  const seen = new Set<string>();
  return xs.filter((x) => {
    const k = normalizeAdminName(x);
    if (!x || !k || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

const matchesAny = (value: string | null, hints: string[]) => {
  const v = normalizeAdminName(value);
  return !!v && hints.some((h) => normalizeAdminName(h) === v);
};

/** Keep rows inside the district/municipality the geocoder named. */
function inArea(rows: OfficialChainRow[], dHints: string[]): OfficialChainRow[] {
  if (dHints.length === 0) return [];
  return rows.filter((r) => matchesAny(r.district, dHints) || matchesAny(r.county, dHints) || matchesAny(r.subcounty, dHints));
}

/** Narrow by division/ward names when that still leaves something. */
function preferArea(rows: OfficialChainRow[], aHints: string[]): OfficialChainRow[] {
  if (rows.length <= 1 || aHints.length === 0) return rows;
  const narrowed = rows.filter((r) => matchesAny(r.parish, aHints) || matchesAny(r.subcounty, aHints));
  return narrowed.length > 0 ? narrowed : rows;
}

/** The value of a level only when all candidates agree on it. */
function common(rows: OfficialChainRow[], key: keyof OfficialChainRow): string {
  const vals = new Set(rows.map((r) => clean(r[key])));
  return vals.size === 1 ? [...vals][0] : '';
}

/**
 * Fill County / Sub-County / Parish (and official District / Village spelling) from the
 * dataset. Levels already confirmed by a more specific match win; nothing is invented.
 */
export function mergeOfficialChain(
  loc: SignageGpsLocation,
  a: Record<string, string>,
  c: OfficialCandidates,
): SignageGpsLocation {
  const dHints = uniq([...districtHints(a), loc.district]);
  const aHints = uniq([...areaHints(a), loc.subcounty]);

  let rows = preferArea(inArea(c.villages, dHints), aHints);
  let level: 'village' | 'parish' | 'county' | null = rows.length ? 'village' : null;
  if (!level) {
    rows = preferArea(inArea(c.parishes, dHints), aHints);
    if (rows.length) level = 'parish';
  }
  if (!level) {
    rows = inArea(c.counties, dHints);
    if (rows.length) level = 'county';
  }
  if (!level) return loc;

  const district = common(rows, 'district');
  const county = common(rows, 'county');
  const subcounty = level === 'county' ? '' : common(rows, 'subcounty');
  const parish = level === 'county' ? '' : common(rows, 'parish');
  const village = level === 'village' ? common(rows, 'village') : '';

  return {
    ...loc,
    district: district || loc.district,
    county: county || loc.county,
    subcounty: subcounty || loc.subcounty,
    parish: parish || loc.parish,
    // Official spelling of the same village; never replace a GPS village with a different one.
    village: village && loc.villageFound ? village : loc.village,
  };
}

/** PostgREST nested row → flat chain. */
export function flattenChain(row: any, from: 'village' | 'parish' | 'county'): OfficialChainRow {
  const parish = from === 'village' ? row?.parish : from === 'parish' ? row : null;
  const subcounty = parish?.subcounty ?? null;
  const county = from === 'county' ? row : subcounty?.county ?? null;
  return {
    village: from === 'village' ? row?.name ?? null : null,
    parish: parish?.name ?? null,
    subcounty: subcounty?.name ?? null,
    county: county?.name ?? null,
    district: county?.district?.name ?? null,
  };
}
