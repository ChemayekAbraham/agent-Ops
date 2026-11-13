/**
 * Completes a GPS signage location with the official Uganda administrative chain
 * (ug_districts → ug_counties → ug_subcounties → ug_parishes → ug_villages).
 *
 * Urban areas use the municipal structure, which the dataset already stores at the
 * matching rural level:
 *   City / Municipality  → County      (e.g. "Entebbe Municipality")
 *   Division / Town Council → Sub-County (e.g. "Division A", "Katabi Town Council")
 *   Ward                 → Parish      (e.g. "NKUMBA WARD")
 *   Cell                 → Village     (e.g. "NKUMBA BENDEGERE")
 *
 * The geocoders' place names are not official and their city boundaries are loose
 * (OpenStreetMap puts Nkumba in "Entebbe City"; officially it is Katabi Town Council,
 * Busiro County South). So the city name is used only to find the district, and the
 * finer levels come from keyword matches against official village / ward names inside
 * that district. A level is filled only when the best matches agree on it.
 *
 * Pure matching only — no network. The caller fetches candidate rows.
 */
import type { SignageGpsLocation } from './signageGpsLocation';

/** One official chain, flattened. */
export interface OfficialChainRow {
  village: string | null;
  parish: string | null;
  subcounty: string | null;
  county: string | null;
  district: string | null;
}

export interface OfficialCandidates {
  /** Official district names the geocoder's district / city / municipality resolved to. */
  districts: string[];
  /** Village rows in those districts whose village or ward name shares a keyword. */
  villages: OfficialChainRow[];
}

/** Structural words: "Entebbe City" = "Entebbe Municipality" = "Entebbe". */
const STRUCTURE = /\b(city|capital|municipality|municipal|council|district|division|town|tc|ward|cell|village|parish|sub ?county|county)\b/g;
/** Words that say nothing about which place this is. */
const NOISE = new Set([
  'road', 'rd', 'street', 'st', 'avenue', 'lane', 'close', 'drive', 'way', 'highway', 'bypass',
  'primary', 'secondary', 'school', 'college', 'university', 'church', 'mosque', 'hospital',
  'health', 'centre', 'center', 'market', 'stage', 'trading', 'estate', 'plot', 'the', 'and',
  'north', 'south', 'east', 'west', 'northern', 'southern', 'eastern', 'western', 'upper', 'lower',
  'uganda', 'region', 'zone', 'central', 'borough',
].map((w) => w.replace(/([a-z])\1+/g, '$1'))); // compared after doubled letters collapse ("school" → "schol")

/**
 * Lowercase, drop structural words and punctuation, and collapse doubled letters so the
 * dataset's spellings match the geocoders' ("Luweero" = "Luwero", "Ssembabule" = "Sembabule",
 * "Kassanda" = "Kasanda", "Bukoto Ii" = "Bukoto I").
 */
export function normalizeAdminName(s: string | null | undefined): string {
  return (s || '').toLowerCase().replace(STRUCTURE, ' ').replace(/[^a-z0-9]+/g, ' ')
    // Cell numerals stay distinct before letters collapse: "II" must not become "I".
    .replace(/\b(iii|ii|iv|i)\b/g, (r) => ({ i: '1', ii: '2', iii: '3', iv: '4' })[r] as string)
    .replace(/([a-z])\1+/g, '$1').trim();
}

/** Case-insensitive regex for a normalised token that tolerates doubled letters ("kasanda" → k+a+s+a+n+d+a+). */
export function tokenRegex(token: string): string {
  return token.replace(/[^a-z0-9]/g, '').split('').map((ch) => `${ch}+`).join('');
}

export interface AdminUnit { id: number; name: string }
export interface CountyUnit { name: string; district: AdminUnit }

const tokenSet = (s: string | null | undefined) => new Set(placeTokens(s));
const within = (unit: Set<string>, hint: Set<string>) => unit.size > 0 && [...unit].every((t) => hint.has(t));

/**
 * Official district(s) for the geocoder's names, checked in order of reliability
 * (district, state_district, county, municipality, city, town). A district matches when all
 * its words appear in the hint ("Kampala Capital City" → Kampala); otherwise a municipality /
 * county does ("Entebbe City" → Entebbe Municipality → Wakiso, "Busiro" → Wakiso).
 */
export function resolveDistricts(a: Record<string, string>, districts: AdminUnit[], counties: CountyUnit[]): AdminUnit[] {
  const hints = districtHints(a).map(tokenSet).filter((h) => h.size > 0);
  for (const h of hints) {
    const hit = districts.filter((d) => within(tokenSet(d.name), h));
    if (hit.length) return hit;
  }
  for (const h of hints) {
    const hit = counties.filter((c) => within(tokenSet(c.name), h)).map((c) => c.district);
    if (hit.length) return [...new Map(hit.map((d) => [d.id, d])).values()];
  }
  return [];
}

/** Distinctive words of a place name ("Nkumba Primary School" → ["nkumba"]). */
export function placeTokens(s: string | null | undefined): string[] {
  return normalizeAdminName(s).split(' ').filter((w) => w.length >= 4 && !NOISE.has(w) && !/^\d+$/.test(w));
}

const clean = (s: string | null | undefined) => (s || '').replace(/\s+/g, ' ').trim();
const uniq = (xs: string[]) => [...new Set(xs.filter(Boolean))];

/** Names the geocoder gave for the district / city / municipality level. */
export function districtHints(a: Record<string, string>): string[] {
  return uniq(['district', 'state_district', 'county', 'municipality', 'city', 'town'].map((k) => clean(a[k])));
}

/** Keywords for the cell / village level. */
export function villageTokens(a: Record<string, string>): string[] {
  return uniq(['village', 'hamlet', 'neighbourhood', 'residential', 'quarter', 'locality'].flatMap((k) => placeTokens(a[k])));
}

/** Keywords for the ward / division level (also roads and landmarks named after the area). */
export function areaTokens(a: Record<string, string>): string[] {
  return uniq(['city_district', 'suburb', 'subcounty', 'sub_county', 'parish', 'road', 'amenity', 'building', 'shop']
    .flatMap((k) => placeTokens(a[k])));
}

/** Every keyword worth searching the dataset for, minus the district/city name itself. */
export function searchTokens(a: Record<string, string>): string[] {
  const districtWords = new Set(districtHints(a).flatMap(placeTokens));
  return uniq([...villageTokens(a), ...areaTokens(a)]).filter((t) => !districtWords.has(t));
}

function score(row: OfficialChainRow, vt: string[], at: string[], gpsVillage: string): { score: number; villageHit: boolean } {
  // The same cell by name ("Kasusu B" = "KASUSU  B", "Kasana B" = "KASAANA B") settles it.
  const exact = !!gpsVillage && normalizeAdminName(row.village) === normalizeAdminName(gpsVillage);
  const v = new Set(placeTokens(row.village));
  const p = new Set(placeTokens(row.parish));
  const s = new Set(placeTokens(row.subcounty));
  const villageHits = vt.filter((t) => v.has(t)).length;
  const total =
    4 * villageHits +
    2 * [...vt, ...at].filter((t) => p.has(t)).length +
    1 * at.filter((t) => v.has(t)).length +
    1 * at.filter((t) => s.has(t)).length;
  return { score: total + (exact ? 10 : 0), villageHit: exact || villageHits > 0 };
}

function common(rows: OfficialChainRow[], key: keyof OfficialChainRow): string {
  const vals = new Set(rows.map((r) => clean(r[key])));
  return vals.size === 1 ? [...vals][0] : '';
}

/**
 * Fill District / County / Sub-County / Parish (and the official cell name) from the dataset.
 * - Village keyword hit → the whole official chain of the best-scoring cell.
 * - Only a ward keyword hit → ward and above; the GPS village is kept.
 * - No keyword hit → only the official district; County is NOT guessed from the city name.
 */
export function mergeOfficialChain(
  loc: SignageGpsLocation,
  a: Record<string, string>,
  c: OfficialCandidates,
): SignageGpsLocation {
  const districts = uniq(c.districts.map(clean));
  const district = districts.length === 1 ? districts[0] : '';
  const vt = villageTokens(a).filter((t) => searchTokens(a).includes(t));
  const at = areaTokens(a).filter((t) => searchTokens(a).includes(t));

  const scored = c.villages
    .filter((r) => !district || clean(r.district) === district)
    .map((r) => ({ r, ...score(r, vt, at, loc.village) }))
    .filter((x) => x.score >= 2);
  const best = scored.reduce((m, x) => Math.max(m, x.score), 0);
  const top = scored.filter((x) => x.score === best);
  const rows = top.map((x) => x.r);

  if (rows.length === 0) {
    return district ? { ...loc, district } : loc;
  }
  const villageLevel = top.every((x) => x.villageHit);
  return {
    ...loc,
    district: common(rows, 'district') || district || loc.district,
    county: common(rows, 'county') || loc.county,
    subcounty: common(rows, 'subcounty') || loc.subcounty,
    parish: common(rows, 'parish') || loc.parish,
    village: villageLevel && common(rows, 'village') ? common(rows, 'village') : loc.village,
  };
}
