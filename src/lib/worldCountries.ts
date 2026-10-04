/**
 * Country / city data for the profile-completion location picker.
 *
 * Countries (with ISO codes for city lookups) come from the
 * `country-state-city` dataset so we can offer EVERY city/town in the
 * world. We layer a best-effort continent map on top so the continent
 * field can auto-fill from a country pick.
 *
 * IMPORTANT: the `country-state-city` city dataset is ~8 MB. It is NOT
 * bundled as JavaScript — it is emitted as a static JSON asset and fetched
 * on demand only when a country has been picked and the city list is
 * actually needed. The (small, ~95 KB) country dataset is imported from the
 * package subpath so picking a country never pulls the city data in.
 * This keeps it out of the startup bundle AND out of Rollup's
 * parse/minify path during production builds.
 */
// Static URL only — Vite copies the JSON into dist/assets verbatim and this
// import compiles down to a single string, not the dataset itself.
import cityDataUrl from "country-state-city/lib/assets/city.json?url";

export interface WorldCountry {
  name: string;
  continent: string;
  isoCode: string;
}

/** Best-effort continent lookup keyed by ISO-3166 alpha-2 code. */
const CONTINENT_BY_ISO: Record<string, string> = {
  // Africa
  DZ: "Africa", AO: "Africa", BJ: "Africa", BW: "Africa", BF: "Africa", BI: "Africa",
  CV: "Africa", CM: "Africa", CF: "Africa", TD: "Africa", KM: "Africa", CG: "Africa",
  CD: "Africa", CI: "Africa", DJ: "Africa", EG: "Africa", GQ: "Africa", ER: "Africa",
  SZ: "Africa", ET: "Africa", GA: "Africa", GM: "Africa", GH: "Africa", GN: "Africa",
  GW: "Africa", KE: "Africa", LS: "Africa", LR: "Africa", LY: "Africa", MG: "Africa",
  MW: "Africa", ML: "Africa", MR: "Africa", MU: "Africa", MA: "Africa", MZ: "Africa",
  NA: "Africa", NE: "Africa", NG: "Africa", RW: "Africa", ST: "Africa", SN: "Africa",
  SC: "Africa", SL: "Africa", SO: "Africa", ZA: "Africa", SS: "Africa", SD: "Africa",
  TZ: "Africa", TG: "Africa", TN: "Africa", UG: "Africa", ZM: "Africa", ZW: "Africa",
  // Asia
  AF: "Asia", AM: "Asia", AZ: "Asia", BH: "Asia", BD: "Asia", BT: "Asia", BN: "Asia",
  KH: "Asia", CN: "Asia", CY: "Asia", GE: "Asia", IN: "Asia", ID: "Asia", IR: "Asia",
  IQ: "Asia", IL: "Asia", JP: "Asia", JO: "Asia", KZ: "Asia", KW: "Asia", KG: "Asia",
  LA: "Asia", LB: "Asia", MY: "Asia", MV: "Asia", MN: "Asia", MM: "Asia", NP: "Asia",
  KP: "Asia", OM: "Asia", PK: "Asia", PS: "Asia", PH: "Asia", QA: "Asia", SA: "Asia",
  SG: "Asia", KR: "Asia", LK: "Asia", SY: "Asia", TW: "Asia", TJ: "Asia", TH: "Asia",
  TL: "Asia", TR: "Asia", TM: "Asia", AE: "Asia", UZ: "Asia", VN: "Asia", YE: "Asia",
  // Europe
  AL: "Europe", AD: "Europe", AT: "Europe", BY: "Europe", BE: "Europe", BA: "Europe",
  BG: "Europe", HR: "Europe", CZ: "Europe", DK: "Europe", EE: "Europe", FI: "Europe",
  FR: "Europe", DE: "Europe", GR: "Europe", HU: "Europe", IS: "Europe", IE: "Europe",
  IT: "Europe", XK: "Europe", LV: "Europe", LI: "Europe", LT: "Europe", LU: "Europe",
  MT: "Europe", MD: "Europe", MC: "Europe", ME: "Europe", NL: "Europe", MK: "Europe",
  NO: "Europe", PL: "Europe", PT: "Europe", RO: "Europe", RU: "Europe", SM: "Europe",
  RS: "Europe", SK: "Europe", SI: "Europe", ES: "Europe", SE: "Europe", CH: "Europe",
  UA: "Europe", GB: "Europe", VA: "Europe",
  // North America
  AG: "North America", BS: "North America", BB: "North America", BZ: "North America",
  CA: "North America", CR: "North America", CU: "North America", DM: "North America",
  DO: "North America", SV: "North America", GD: "North America", GT: "North America",
  HT: "North America", HN: "North America", JM: "North America", MX: "North America",
  NI: "North America", PA: "North America", KN: "North America", LC: "North America",
  VC: "North America", TT: "North America", US: "North America",
  // South America
  AR: "South America", BO: "South America", BR: "South America", CL: "South America",
  CO: "South America", EC: "South America", GY: "South America", PY: "South America",
  PE: "South America", SR: "South America", UY: "South America", VE: "South America",
  // Oceania
  AU: "Oceania", FJ: "Oceania", KI: "Oceania", MH: "Oceania", FM: "Oceania",
  NR: "Oceania", NZ: "Oceania", PW: "Oceania", PG: "Oceania", WS: "Oceania",
  SB: "Oceania", TO: "Oceania", TV: "Oceania", VU: "Oceania",
};

// In-memory cache so the heavy dataset is parsed at most once per session.
let _countriesCache: WorldCountry[] | null = null;
let _countriesPromise: Promise<WorldCountry[]> | null = null;

/** Lazily load every country in the world (cached after first call). */
export async function loadWorldCountries(): Promise<WorldCountry[]> {
  if (_countriesCache) return _countriesCache;
  if (!_countriesPromise) {
    // Subpath import: pulls ONLY country.json (~95 KB), never city.json.
    _countriesPromise = import("country-state-city/lib/country.js").then((mod) => {
      const Country = ((mod as { default?: unknown }).default ?? mod) as {
        getAllCountries: () => Array<{ name: string; isoCode: string }>;
      };
      _countriesCache = Country.getAllCountries().map((c) => ({
        name: c.name,
        isoCode: c.isoCode,
        continent: CONTINENT_BY_ISO[c.isoCode] ?? "",
      }));
      return _countriesCache;
    });
  }
  return _countriesPromise;
}

/** Uganda-first ordering so the most common pick is at the top. */
export async function loadWorldCountriesUgandaFirst(): Promise<WorldCountry[]> {
  const all = await loadWorldCountries();
  const ug = all.find((c) => c.isoCode === "UG");
  const rest = all
    .filter((c) => c.isoCode !== "UG")
    .sort((a, b) => a.name.localeCompare(b.name));
  return ug ? [ug, ...rest] : rest;
}

/**
 * Synchronous continent lookup. Returns null until the dataset has been
 * loaded at least once via `loadWorldCountries()` (the picker does this
 * when it opens).
 */
export function continentForCountry(name: string): string | null {
  return _countriesCache?.find((c) => c.name === name)?.continent ?? null;
}

/** Synchronous ISO lookup. Null until the dataset has been loaded once. */
export function isoForCountry(name: string): string | null {
  return _countriesCache?.find((c) => c.name === name)?.isoCode ?? null;
}

export interface WorldCity {
  name: string;
  stateCode: string;
}

/**
 * Raw city rows as shipped by `country-state-city`:
 * [name, countryCode, stateCode, latitude, longitude]
 */
type RawCityRow = [string, string, string, string, string];

let _cityRowsPromise: Promise<RawCityRow[]> | null = null;

/** Fetch + cache the raw city dataset (once per session). */
async function loadRawCityRows(): Promise<RawCityRow[]> {
  if (!_cityRowsPromise) {
    _cityRowsPromise = fetch(cityDataUrl)
      .then((res) => {
        if (!res.ok) throw new Error(`city dataset ${res.status}`);
        return res.json() as Promise<RawCityRow[]>;
      })
      .catch((err) => {
        // Allow a later retry instead of caching the failure forever.
        _cityRowsPromise = null;
        throw err;
      });
  }
  return _cityRowsPromise;
}

/** All cities/towns for a country (deduplicated by name), alphabetically sorted. */
export async function loadCitiesForCountry(isoCode: string): Promise<WorldCity[]> {
  if (!isoCode) return [];
  const rows = await loadRawCityRows();
  const seen = new Set<string>();
  const out: WorldCity[] = [];
  for (const row of rows) {
    if (row[1] !== isoCode) continue;
    const name = row[0];
    if (seen.has(name)) continue;
    seen.add(name);
    out.push({ name, stateCode: row[2] });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}