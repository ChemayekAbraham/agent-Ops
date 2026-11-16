import { useMemo, useState } from 'react';
import {
  ArrowLeft,
  ArrowUpDown,
  Building2,
  ChevronRight,
  Compass,
  Globe,
  Home,
  Layers,
  Loader2,
  Map as MapIcon,
  MapPin,
  Search,
  X,
} from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { formatUGX } from '@/lib/rentCalculations';
import {
  normalizeDistrict,
  normalizeUgandaRegion,
  UGANDA_DISTRICT_AREAS,
  UGANDA_REGION_GROUPS,
  UGANDA_REGIONS,
} from '@/lib/ugandaDistricts';
import {
  findUgDistrictByName,
  useUgDistricts,
  useUgParishes,
  useUgSubcountiesByDistrict,
  useUgVillages,
} from '@/hooks/useUgLocations';

export interface RentRequestGeoPath {
  continent?: string;
  country?: string;
  region?: string;
  district?: string;
  districtId?: number;
  subcounty?: string;
  subcountyId?: number;
  parish?: string;
  parishId?: number;
  village?: string;
  villageId?: number;
}

export interface ResolvedRentRequestGeo {
  continent: string;
  country: string;
  region: string;
  district: string;
  subcounty: string;
  parish: string;
  village: string;
}

const UNSPECIFIED_REGION = 'Unspecified Region';
const UNSPECIFIED_DISTRICT = 'Unspecified District';
const UNSPECIFIED_SUBCOUNTY = 'Unspecified Sub-county / Ward';
const UNSPECIFIED_PARISH = 'Unspecified Parish / Cell';
const UNSPECIFIED_VILLAGE = 'Unspecified Village';

const CONTINENTS: Array<{
  name: string;
  subtitle: string;
  emoji: string;
}> = [
  { name: 'Africa', subtitle: 'East, West, Central, North & Southern Africa', emoji: '🌍' },
  { name: 'Europe', subtitle: 'United Kingdom, Western & Central Europe', emoji: '🌍' },
  { name: 'Asia', subtitle: 'Middle East, South, East & Southeast Asia', emoji: '🌏' },
];

const COUNTRIES_BY_CONTINENT: Record<
  string,
  Array<{ name: string; flag: string; subtitle: string }>
> = {
  Africa: [
    { name: 'Uganda', flag: '🇺🇬', subtitle: 'Central, Eastern, Western & Northern Regions' },
    { name: 'Kenya', flag: '🇰🇪', subtitle: 'East Africa' },
    { name: 'Tanzania', flag: '🇹🇿', subtitle: 'East Africa' },
    { name: 'Rwanda', flag: '🇷🇼', subtitle: 'East Africa' },
    { name: 'South Sudan', flag: '🇸🇸', subtitle: 'East Africa' },
    { name: 'DR Congo', flag: '🇨🇩', subtitle: 'Central Africa' },
    { name: 'Nigeria', flag: '🇳🇬', subtitle: 'West Africa' },
    { name: 'Ghana', flag: '🇬🇭', subtitle: 'West Africa' },
    { name: 'South Africa', flag: '🇿🇦', subtitle: 'Southern Africa' },
    { name: 'Zambia', flag: '🇿🇲', subtitle: 'Southern Africa' },
    { name: 'Ethiopia', flag: '🇪🇹', subtitle: 'Horn of Africa' },
    { name: 'Egypt', flag: '🇪🇬', subtitle: 'North Africa' },
  ],
  Europe: [
    { name: 'United Kingdom', flag: '🇬🇧', subtitle: 'England, Scotland, Wales & N. Ireland' },
    { name: 'Germany', flag: '🇩🇪', subtitle: 'Western Europe' },
    { name: 'France', flag: '🇫🇷', subtitle: 'Western Europe' },
    { name: 'Netherlands', flag: '🇳🇱', subtitle: 'Western Europe' },
    { name: 'Italy', flag: '🇮🇹', subtitle: 'Southern Europe' },
    { name: 'Spain', flag: '🇪🇸', subtitle: 'Southern Europe' },
    { name: 'Sweden', flag: '🇸🇪', subtitle: 'Northern Europe' },
  ],
  Asia: [
    { name: 'United Arab Emirates', flag: '🇦🇪', subtitle: 'Middle East' },
    { name: 'Saudi Arabia', flag: '🇸🇦', subtitle: 'Middle East' },
    { name: 'Qatar', flag: '🇶🇦', subtitle: 'Middle East' },
    { name: 'India', flag: '🇮🇳', subtitle: 'South Asia' },
    { name: 'China', flag: '🇨🇳', subtitle: 'East Asia' },
    { name: 'Singapore', flag: '🇸🇬', subtitle: 'Southeast Asia' },
    { name: 'Japan', flag: '🇯🇵', subtitle: 'East Asia' },
  ],
};

// Curated Kampala Divisions -> Parishes mapping so Kampala drills cleanly from Division -> Parish -> Village
const KAMPALA_DIVISION_PARISHES: Record<string, string[]> = {
  'Central Division': [
    'Bukesa', 'Civic Centre', 'Industrial Area', 'Kagugube', 'Kamwokya I',
    'Kisenyi I', 'Kisenyi II', 'Kisenyi III', 'Kololo I', 'Kololo II',
    'Kololo III', 'Kololo IV', 'Mengo', 'Nakasero I', 'Nakasero II',
    'Nakasero III', 'Nakasero IV', 'Nakivubo', 'Old Kampala',
  ],
  'Kawempe Division': [
    'Bwaise I', 'Bwaise II', 'Bwaise III', 'Kalerwe', 'Kanyanya',
    'Kawempe I', 'Kawempe II', 'Kazo', 'Komamboga', 'Kyebando',
    'Makerere I', 'Makerere II', 'Makerere III', 'Mpererwe',
    'Mulago I', 'Mulago II', 'Mulago III', 'Nsooba',
  ],
  'Makindye Division': [
    'Bukasa', 'Buziga', 'Ggaba', 'Kabalagala', 'Kansanga', 'Katwe I',
    'Katwe II', 'Kibuli', 'Kibuye I', 'Kibuye II', 'Lukuli', 'Luwafu',
    'Makindye I', 'Makindye II', 'Nsambya Central', 'Nsambya Estate',
    'Nsambya Railways', 'Salaama', 'Wabigalo',
  ],
  'Nakawa Division': [
    'Banda', 'Bugolobi', 'Butabika', 'Kanyanya (Nakawa)', 'Kiswa',
    'Kitintale', 'Kyambogo', 'Luzira', 'Mbuya I', 'Mbuya II',
    'Mutungo', 'Naguru I', 'Naguru II', 'Nakawa', 'Ntinda',
  ],
  'Rubaga Division': [
    'Busega', 'Kasubi', 'Kawaala', 'Lubaga', 'Lubya', 'Lungujja',
    'Mutundwe', 'Najjanankumbi I', 'Najjanankumbi II', 'Nakulabye',
    'Namirembe', 'Namungoona', 'Nateete', 'Ndeeba',
  ],
};

const cleanText = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/**
 * Resolves a rent request row into its canonical geographic hierarchy:
 * Continent -> Country -> Region -> District -> County/Sub-county/Division/Ward -> Parish/Cell -> Village.
 *
 * Example: a rent request from Kampala or Wakiso resolves to:
 * Africa -> Uganda -> Central Region -> Kampala / Wakiso -> Division/Sub-county -> Parish -> Village.
 */
export function resolveRentRequestGeo(req: any): ResolvedRentRequestGeo {
  const continent = 'Africa';
  const country = 'Uganda';

  const rawDistrict =
    cleanText(req.landlord_district) ||
    cleanText(req.tenant_district) ||
    cleanText(req.lc1_district) ||
    cleanText(req.request_city);

  const rawRegion =
    cleanText(req.landlord_region) ||
    cleanText(req.tenant_region) ||
    cleanText(req.lc1_region);

  // Normalize district first (e.g., "Entebbe" or "Nansana" or "Kira" -> "Wakiso", "Kampala" -> "Kampala")
  const normalizedDist = normalizeDistrict(rawDistrict || rawRegion);
  const district =
    normalizedDist && !UGANDA_REGIONS.some((r) => r.toLowerCase() === normalizedDist.toLowerCase())
      ? normalizedDist
      : UNSPECIFIED_DISTRICT;

  // Normalize region (e.g., "Kampala" or "Wakiso" -> "Central" -> "Central Region")
  const regionCandidate = normalizeUgandaRegion(
    rawRegion || (district !== UNSPECIFIED_DISTRICT ? district : rawDistrict),
  );
  const region =
    regionCandidate && regionCandidate !== 'Unknown region'
      ? regionCandidate.endsWith('Region')
        ? regionCandidate
        : `${regionCandidate} Region`
      : UNSPECIFIED_REGION;

  const rawSubcounty =
    cleanText(req.landlord_sub_county) ||
    cleanText(req.tenant_sub_county) ||
    (rawDistrict && rawDistrict.toLowerCase() !== district.toLowerCase() ? rawDistrict : '');

  const rawParish = cleanText(req.tenant_parish) || cleanText(req.lc1_parish);
  const rawVillage =
    cleanText(req.landlord_village) ||
    cleanText(req.tenant_village) ||
    cleanText(req.lc1_village);

  // If Kampala parish is known and subcounty isn't explicitly set to one of the 5 Divisions, infer the Division
  let subcounty = rawSubcounty || UNSPECIFIED_SUBCOUNTY;
  if (district === 'Kampala' && subcounty === UNSPECIFIED_SUBCOUNTY && rawParish) {
    for (const [divName, parishes] of Object.entries(KAMPALA_DIVISION_PARISHES)) {
      if (parishes.some((p) => p.toLowerCase() === rawParish.toLowerCase())) {
        subcounty = divName;
        break;
      }
    }
  }

  return {
    continent,
    country,
    region,
    district,
    subcounty,
    parish: rawParish || UNSPECIFIED_PARISH,
    village: rawVillage || UNSPECIFIED_VILLAGE,
  };
}

const cleanAdminToken = (v: string): string =>
  v
    .trim()
    .toLowerCase()
    .replace(/\b(kampala|district|sub-county|subcounty|division|town council|municipality|municipal council|county|parish|ward|village|cell|zone)\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();

function looselyMatchesAdminName(a?: string, b?: string): boolean {
  if (!a || !b) return false;
  const al = a.trim().toLowerCase();
  const bl = b.trim().toLowerCase();
  if (al === bl) return true;
  const ac = cleanAdminToken(a);
  const bc = cleanAdminToken(b);
  return Boolean(ac && bc && ac === bc);
}

export function matchesRentRequestGeoPath(req: any, path: RentRequestGeoPath): boolean {
  const geo = resolveRentRequestGeo(req);
  if (path.continent && geo.continent !== path.continent) return false;
  if (path.country && geo.country !== path.country) return false;
  if (path.region && geo.region !== path.region) return false;
  if (path.district && !looselyMatchesAdminName(geo.district, path.district)) return false;
  if (path.subcounty && !looselyMatchesAdminName(geo.subcounty, path.subcounty)) return false;
  if (path.parish && !looselyMatchesAdminName(geo.parish, path.parish)) return false;
  if (path.village && !looselyMatchesAdminName(geo.village, path.village)) return false;
  return true;
}

type GeoLevel =
  | 'continent'
  | 'country'
  | 'region'
  | 'district'
  | 'subcounty'
  | 'parish'
  | 'village'
  | 'leaf';

function currentGeoLevel(path: RentRequestGeoPath): GeoLevel {
  if (!path.continent) return 'continent';
  if (!path.country) return 'country';
  if (!path.region) return 'region';
  if (!path.district) return 'district';
  if (!path.subcounty) return 'subcounty';
  if (!path.parish) return 'parish';
  if (!path.village) return 'village';
  return 'leaf';
}

const LEVEL_TITLES: Record<GeoLevel, { title: string; subtitle: string }> = {
  continent: {
    title: 'Select a Continent',
    subtitle: 'Choose a continent (Africa, Europe, or Asia) to filter pending Rent Requests by location.',
  },
  country: {
    title: 'Select a Country',
    subtitle: 'Countries ordered by pending Rent Requests. Tap a country to drill into its regions.',
  },
  region: {
    title: 'Select a Region',
    subtitle: 'Choose an administrative region (e.g. Central Region for Kampala & Wakiso).',
  },
  district: {
    title: 'Select a District',
    subtitle: 'Choose a district to drill into its counties, divisions, sub-counties or wards.',
  },
  subcounty: {
    title: 'Select County / Division / Sub-county / Ward',
    subtitle: 'Choose a county, municipal division, town council, sub-county or ward to view its parishes.',
  },
  parish: {
    title: 'Select Parish / Ward / Cell',
    subtitle: 'Choose a parish, ward or cell to drill down into its villages.',
  },
  village: {
    title: 'Select Village / Cell / Zone',
    subtitle: 'Choose a village or cell to inspect specific Rent Requests.',
  },
  leaf: {
    title: 'Location Filtered Rent Requests',
    subtitle: 'Showing all pending Rent Requests in this village.',
  },
};

interface GeoTileItem {
  key: string;
  label: string;
  subtitle?: string;
  emoji?: string;
  ugId?: number;
  count: number;
  amount: number;
}

type SortOrder = 'asc_active' | 'desc' | ' alpha';

interface RentRequestsGeoDrilldownProps {
  requests: any[];
  path: RentRequestGeoPath;
  onPathChange: (next: RentRequestGeoPath) => void;
  onBackToHeroCard: () => void;
}

export function RentRequestsGeoDrilldown({
  requests,
  path,
  onPathChange,
  onBackToHeroCard,
}: RentRequestsGeoDrilldownProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [sortOrder, setSortOrder] = useState<SortOrder>('asc_active');

  const level = currentGeoLevel(path);

  // Official Uganda administrative hierarchy queries (cached for the whole session)
  const ugDistrictsQuery = useUgDistricts(null);

  const resolvedDistrictId = useMemo<number | null>(() => {
    if (path.districtId != null) return path.districtId;
    if (!path.district || path.district === UNSPECIFIED_DISTRICT) return null;
    const aliasMap: Record<string, string> = {
      entebbe: 'Wakiso',
      'fort portal': 'Kabarole',
      sembabule: 'Ssembabule',
      ssembabule: 'Sembabule',
    };
    const direct = findUgDistrictByName(ugDistrictsQuery.data, path.district);
    if (direct) return direct.id;
    const aliased = aliasMap[path.district.trim().toLowerCase()];
    if (aliased) {
      const hit = findUgDistrictByName(ugDistrictsQuery.data, aliased);
      if (hit) return hit.id;
    }
    return null;
  }, [path.district, path.districtId, ugDistrictsQuery.data]);

  const ugSubcountiesQuery = useUgSubcountiesByDistrict(resolvedDistrictId);

  const resolvedSubcountyId = useMemo<number | null>(() => {
    if (path.subcountyId != null) return path.subcountyId;
    if (!path.subcounty || path.subcounty === UNSPECIFIED_SUBCOUNTY) return null;
    const list = ugSubcountiesQuery.data ?? [];
    const exact = list.find((s) => s.name.trim().toLowerCase() === path.subcounty!.trim().toLowerCase());
    if (exact) return exact.id;
    const loose = list.find((s) => looselyMatchesAdminName(s.name, path.subcounty));
    return loose ? loose.id : null;
  }, [path.subcounty, path.subcountyId, ugSubcountiesQuery.data]);

  const ugParishesQuery = useUgParishes(resolvedSubcountyId);

  const resolvedParishId = useMemo<number | null>(() => {
    if (path.parishId != null) return path.parishId;
    if (!path.parish || path.parish === UNSPECIFIED_PARISH) return null;
    const list = ugParishesQuery.data ?? [];
    const exact = list.find((p) => p.name.trim().toLowerCase() === path.parish!.trim().toLowerCase());
    if (exact) return exact.id;
    const loose = list.find((p) => looselyMatchesAdminName(p.name, path.parish));
    return loose ? loose.id : null;
  }, [path.parish, path.parishId, ugParishesQuery.data]);

  const ugVillagesQuery = useUgVillages(resolvedParishId);

  const isLoadingLevel =
    (level === 'subcounty' && resolvedDistrictId != null && ugSubcountiesQuery.isLoading) ||
    (level === 'parish' && resolvedSubcountyId != null && ugParishesQuery.isLoading) ||
    (level === 'village' && resolvedParishId != null && ugVillagesQuery.isLoading);

  // Requests matching the current parent path
  const matchingRequests = useMemo(
    () => requests.filter((r) => matchesRentRequestGeoPath(r, path)),
    [requests, path],
  );

  const matchingTotalAmount = useMemo(
    () => matchingRequests.reduce((sum, r) => sum + Number(r.rent_amount || 0), 0),
    [matchingRequests],
  );

  // Build tiles for the current level
  const tiles = useMemo<GeoTileItem[]>(() => {
    const counts = new Map<string, { count: number; amount: number }>();
    for (const req of matchingRequests) {
      const geo = resolveRentRequestGeo(req);
      let val = '';
      switch (level) {
        case 'continent':
          val = geo.continent;
          break;
        case 'country':
          val = geo.country;
          break;
        case 'region':
          val = geo.region;
          break;
        case 'district':
          val = geo.district;
          break;
        case 'subcounty':
          val = geo.subcounty;
          break;
        case 'parish':
          val = geo.parish;
          break;
        case 'village':
          val = geo.village;
          break;
        default:
          break;
      }
      if (!val) continue;
      const prev = counts.get(val) ?? { count: 0, amount: 0 };
      counts.set(val, {
        count: prev.count + 1,
        amount: prev.amount + Number(req.rent_amount || 0),
      });
    }

    const statForName = (name: string): { count: number; amount: number } => {
      const direct = counts.get(name);
      if (direct) return direct;
      let totalCount = 0;
      let totalAmount = 0;
      for (const [k, v] of counts.entries()) {
        if (looselyMatchesAdminName(k, name)) {
          totalCount += v.count;
          totalAmount += v.amount;
        }
      }
      return { count: totalCount, amount: totalAmount };
    };

    let items: GeoTileItem[] = [];

    if (level === 'continent') {
      items = CONTINENTS.map((c) => {
        const stat = counts.get(c.name) ?? { count: 0, amount: 0 };
        return {
          key: c.name,
          label: c.name,
          subtitle: c.subtitle,
          emoji: c.emoji,
          count: stat.count,
          amount: stat.amount,
        };
      });
    } else if (level === 'country') {
      const preset = COUNTRIES_BY_CONTINENT[path.continent || 'Africa'] ?? [];
      const seen = new Set<string>();
      items = preset.map((c) => {
        seen.add(c.name);
        const stat = counts.get(c.name) ?? { count: 0, amount: 0 };
        return {
          key: c.name,
          label: c.name,
          subtitle: c.subtitle,
          emoji: c.flag,
          count: stat.count,
          amount: stat.amount,
        };
      });
      for (const [name, stat] of counts.entries()) {
        if (!seen.has(name)) {
          items.push({
            key: name,
            label: name,
            subtitle: path.continent || 'Country',
            emoji: '🏳️',
            count: stat.count,
            amount: stat.amount,
          });
        }
      }
    } else if (level === 'region') {
      if (path.country === 'Uganda') {
        const ugRegions = [
          { name: 'Central Region', subtitle: 'Kampala, Wakiso, Mukono, Masaka, Mpigi, Luwero…' },
          { name: 'Eastern Region', subtitle: 'Jinja, Mbale, Kapchorwa, Iganga, Soroti, Tororo…' },
          { name: 'Western Region', subtitle: 'Mbarara, Fort Portal, Hoima, Kasese, Kabale…' },
          { name: 'Northern Region', subtitle: 'Gulu, Lira, Arua, Kitgum, Moroto, Nebbi…' },
        ];
        const seen = new Set<string>();
        items = ugRegions.map((r) => {
          seen.add(r.name);
          const stat = counts.get(r.name) ?? { count: 0, amount: 0 };
          return {
            key: r.name,
            label: r.name,
            subtitle: r.subtitle,
            count: stat.count,
            amount: stat.amount,
          };
        });
        for (const [name, stat] of counts.entries()) {
          if (!seen.has(name)) {
            items.push({
              key: name,
              label: name,
              subtitle: 'Requests without a specific region on file',
              count: stat.count,
              amount: stat.amount,
            });
          }
        }
      } else {
        const countryName = path.country || 'Country';
        const fallbackRegions = [
          `${countryName} Central Region`,
          `${countryName} Northern Region`,
          `${countryName} Southern Region`,
          `${countryName} Eastern Region`,
          `${countryName} Western Region`,
        ];
        const seen = new Set<string>();
        for (const [name, stat] of counts.entries()) {
          seen.add(name);
          items.push({
            key: name,
            label: name,
            subtitle: countryName,
            count: stat.count,
            amount: stat.amount,
          });
        }
        for (const rName of fallbackRegions) {
          if (!seen.has(rName)) {
            items.push({
              key: rName,
              label: rName,
              subtitle: countryName,
              count: 0,
              amount: 0,
            });
          }
        }
      }
    } else if (level === 'district') {
      const cleanReg = (path.region || '').replace(/\s+Region$/i, '').trim().toLowerCase();
      const districtMap = new Map<string, number | undefined>();

      // 1. Official ug_districts from database
      for (const d of ugDistrictsQuery.data ?? []) {
        if ((d.region || '').trim().toLowerCase() === cleanReg) {
          districtMap.set(d.name, d.id);
        }
      }

      // 2. Canonical static Uganda districts in this region
      for (const grp of UGANDA_REGION_GROUPS) {
        for (const d of grp.districts) {
          if (d.backendRegion.toLowerCase() === cleanReg && !districtMap.has(d.name)) {
            const dbHit = findUgDistrictByName(ugDistrictsQuery.data, d.name);
            districtMap.set(d.name, dbHit?.id);
          }
        }
      }

      // 3. Any district present on matching requests
      for (const name of counts.keys()) {
        if (!districtMap.has(name)) {
          const dbHit = findUgDistrictByName(ugDistrictsQuery.data, name);
          districtMap.set(name, dbHit?.id);
        }
      }

      // 4. Fallback for non-Ugandan regions so drilldown never stops
      if (districtMap.size === 0) {
        const base = (path.region || path.country || 'Area').replace(/\s+Region$/i, '').trim();
        [`${base} Central`, `${base} Metropolitan`, `${base} North`, `${base} South`].forEach((n) =>
          districtMap.set(n, undefined),
        );
      }

      items = Array.from(districtMap.entries()).map(([name, ugId]) => {
        const stat = statForName(name);
        return {
          key: name,
          label: name === UNSPECIFIED_DISTRICT || name.endsWith('District') ? name : `${name} District`,
          subtitle: `${path.region} · Tap to view counties, divisions & sub-counties`,
          ugId,
          count: stat.count,
          amount: stat.amount,
        };
      });
    } else if (level === 'subcounty') {
      const distName = path.district || '';
      const subcountyMap = new Map<string, number | undefined>();

      // 1. Official sub-counties & divisions from ug_subcounties for this district
      for (const sc of ugSubcountiesQuery.data ?? []) {
        if (!subcountyMap.has(sc.name)) {
          subcountyMap.set(sc.name, sc.id);
        }
      }

      // 2. Static curated divisions/areas if DB returned none
      if (subcountyMap.size === 0) {
        if (distName === 'Kampala') {
          Object.keys(KAMPALA_DIVISION_PARISHES).forEach((div) => subcountyMap.set(div, undefined));
        } else if (UGANDA_DISTRICT_AREAS[distName]) {
          UGANDA_DISTRICT_AREAS[distName].forEach((area) => subcountyMap.set(area, undefined));
        }
      }

      // 3. Any sub-county recorded on active rent requests in this district
      for (const name of counts.keys()) {
        const alreadyMatched = Array.from(subcountyMap.keys()).some((k) =>
          looselyMatchesAdminName(k, name),
        );
        if (!alreadyMatched) {
          subcountyMap.set(name, undefined);
        }
      }

      // 4. Universal fallback if DB is still empty after loading (e.g. non-Ugandan district or offline)
      if (subcountyMap.size === 0 && !ugSubcountiesQuery.isLoading) {
        const cleanDist = distName.replace(/\s+District$/i, '').trim() || 'District';
        [
          `${cleanDist} Town Council`,
          `${cleanDist} Central Sub-county`,
          `${cleanDist} North Sub-county`,
          `${cleanDist} South Sub-county`,
          `${cleanDist} East Sub-county`,
          `${cleanDist} West Sub-county`,
        ].forEach((n) => subcountyMap.set(n, undefined));
      }

      items = Array.from(subcountyMap.entries()).map(([name, ugId]) => {
        const stat = statForName(name);
        return {
          key: name,
          label: name,
          subtitle: `${distName} District · Tap to view parishes & wards`,
          ugId,
          count: stat.count,
          amount: stat.amount,
        };
      });
    } else if (level === 'parish') {
      const subName = path.subcounty || '';
      const parishMap = new Map<string, number | undefined>();

      // 1. Official parishes & wards from ug_parishes for this sub-county
      for (const p of ugParishesQuery.data ?? []) {
        if (!parishMap.has(p.name)) {
          parishMap.set(p.name, p.id);
        }
      }

      // 2. Curated Kampala parishes if DB had none
      if (parishMap.size === 0 && path.district === 'Kampala') {
        const matchedDivKey = Object.keys(KAMPALA_DIVISION_PARISHES).find((div) =>
          looselyMatchesAdminName(div, subName),
        );
        if (matchedDivKey) {
          KAMPALA_DIVISION_PARISHES[matchedDivKey].forEach((p) => parishMap.set(p, undefined));
        }
      }

      // 3. Any parish recorded on active rent requests in this sub-county
      for (const name of counts.keys()) {
        const alreadyMatched = Array.from(parishMap.keys()).some((k) =>
          looselyMatchesAdminName(k, name),
        );
        if (!alreadyMatched) {
          parishMap.set(name, undefined);
        }
      }

      // 4. Universal fallback so every sub-county drills into parishes
      if (parishMap.size === 0 && !ugParishesQuery.isLoading) {
        const cleanSub =
          subName
            .replace(/\b(Sub-county|Subcounty|Division|Town Council|Municipality|Ward)\b/gi, '')
            .trim() || subName;
        [
          `${cleanSub} Central Ward / Parish`,
          `${cleanSub} North Ward / Parish`,
          `${cleanSub} South Ward / Parish`,
          `${cleanSub} East Ward / Parish`,
          `${cleanSub} West Ward / Parish`,
        ].forEach((n) => parishMap.set(n, undefined));
      }

      items = Array.from(parishMap.entries()).map(([name, ugId]) => {
        const stat = statForName(name);
        return {
          key: name,
          label: name,
          subtitle: `${subName} · Tap to view villages & cells`,
          ugId,
          count: stat.count,
          amount: stat.amount,
        };
      });
    } else if (level === 'village') {
      const parishName = path.parish || '';
      const villageMap = new Map<string, number | undefined>();

      // 1. Official villages & cells from ug_villages for this parish
      for (const v of ugVillagesQuery.data ?? []) {
        if (!villageMap.has(v.name)) {
          villageMap.set(v.name, v.id);
        }
      }

      // 2. Any village recorded on active rent requests in this parish
      for (const name of counts.keys()) {
        const alreadyMatched = Array.from(villageMap.keys()).some((k) =>
          looselyMatchesAdminName(k, name),
        );
        if (!alreadyMatched) {
          villageMap.set(name, undefined);
        }
      }

      // 3. Universal fallback so every parish drills down to villages
      if (villageMap.size === 0 && !ugVillagesQuery.isLoading) {
        const cleanPar =
          parishName.replace(/\b(Parish|Ward|Cell)\b/gi, '').trim() || parishName;
        [
          `${cleanPar} Central Village / Cell`,
          `${cleanPar} Cell A / Zone I`,
          `${cleanPar} Cell B / Zone II`,
          `${cleanPar} Cell C / Zone III`,
          `${cleanPar} Trading Centre`,
        ].forEach((n) => villageMap.set(n, undefined));
      }

      items = Array.from(villageMap.entries()).map(([name, ugId]) => {
        const stat = statForName(name);
        return {
          key: name,
          label: name,
          subtitle: `${parishName} · Village / Cell / Zone`,
          ugId,
          count: stat.count,
          amount: stat.amount,
        };
      });
    }

    // Filter by search query if typed
    const q = searchQuery.trim().toLowerCase();
    const filteredItems = q
      ? items.filter(
          (item) =>
            item.label.toLowerCase().includes(q) ||
            item.key.toLowerCase().includes(q) ||
            (item.subtitle && item.subtitle.toLowerCase().includes(q)),
        )
      : items;

    // Sort items:
    // 'asc_active': items with requests (>0) come first in ascending order of count (or Uganda first when 0),
    // followed by 0-request items alphabetically so active locations are always at the top.
    return [...filteredItems].sort((a, b) => {
      if (sortOrder === ' alpha') {
        return a.label.localeCompare(b.label);
      }
      if (sortOrder === 'desc') {
        if (b.count !== a.count) return b.count - a.count;
        if (a.key === 'Uganda' || a.key === 'Africa' || a.key === 'Central Region') return -1;
        if (b.key === 'Uganda' || b.key === 'Africa' || b.key === 'Central Region') return 1;
        return a.label.localeCompare(b.label);
      }
      // Default 'asc_active':
      const aHas = a.count > 0 ? 1 : 0;
      const bHas = b.count > 0 ? 1 : 0;
      if (aHas !== bHas) return bHas - aHas; // active (>0) first so they are immediately visible
      if (a.count !== b.count) return a.count - b.count; // ascending by number of rent requests
      if (a.key === 'Uganda' || a.key === 'Africa' || a.key === 'Central Region' || a.key === 'Kampala' || a.key === 'Wakiso') return -1;
      if (b.key === 'Uganda' || b.key === 'Africa' || b.key === 'Central Region' || b.key === 'Kampala' || b.key === 'Wakiso') return 1;
      return a.label.localeCompare(b.label);
    });
  }, [
    matchingRequests,
    level,
    path,
    searchQuery,
    sortOrder,
    ugDistrictsQuery.data,
    ugSubcountiesQuery.data,
    ugSubcountiesQuery.isLoading,
    ugParishesQuery.data,
    ugParishesQuery.isLoading,
    ugVillagesQuery.data,
    ugVillagesQuery.isLoading,
  ]);

  const handleTileSelect = (tile: GeoTileItem) => {
    setSearchQuery('');
    switch (level) {
      case 'continent':
        onPathChange({ continent: tile.key });
        break;
      case 'country':
        onPathChange({ ...path, country: tile.key });
        break;
      case 'region':
        onPathChange({ ...path, region: tile.key });
        break;
      case 'district':
        onPathChange({ ...path, district: tile.key, districtId: tile.ugId });
        break;
      case 'subcounty':
        onPathChange({ ...path, subcounty: tile.key, subcountyId: tile.ugId });
        break;
      case 'parish':
        onPathChange({ ...path, parish: tile.key, parishId: tile.ugId });
        break;
      case 'village':
        onPathChange({ ...path, village: tile.key, villageId: tile.ugId });
        break;
      default:
        break;
    }
  };

  const handleStepBack = () => {
    setSearchQuery('');
    if (path.village) {
      const { village: _, villageId: __, ...rest } = path;
      onPathChange(rest);
    } else if (path.parish) {
      const { parish: _, parishId: __, ...rest } = path;
      onPathChange(rest);
    } else if (path.subcounty) {
      const { subcounty: _, subcountyId: __, ...rest } = path;
      onPathChange(rest);
    } else if (path.district) {
      const { district: _, districtId: __, ...rest } = path;
      onPathChange(rest);
    } else if (path.region) {
      const { region: _, ...rest } = path;
      onPathChange(rest);
    } else if (path.country) {
      const { country: _, ...rest } = path;
      onPathChange(rest);
    } else if (path.continent) {
      onPathChange({});
    } else {
      onBackToHeroCard();
    }
  };

  const breadcrumbs = useMemo(() => {
    const list: Array<{ label: string; target: RentRequestGeoPath }> = [
      { label: 'Continents', target: {} },
    ];
    if (path.continent) {
      list.push({ label: path.continent, target: { continent: path.continent } });
    }
    if (path.country) {
      list.push({
        label: path.country,
        target: { continent: path.continent, country: path.country },
      });
    }
    if (path.region) {
      list.push({
        label: path.region,
        target: { continent: path.continent, country: path.country, region: path.region },
      });
    }
    if (path.district) {
      list.push({
        label:
          path.district === UNSPECIFIED_DISTRICT || path.district.endsWith('District')
            ? path.district
            : `${path.district} District`,
        target: {
          continent: path.continent,
          country: path.country,
          region: path.region,
          district: path.district,
          districtId: path.districtId,
        },
      });
    }
    if (path.subcounty) {
      list.push({
        label: path.subcounty,
        target: {
          continent: path.continent,
          country: path.country,
          region: path.region,
          district: path.district,
          districtId: path.districtId,
          subcounty: path.subcounty,
          subcountyId: path.subcountyId,
        },
      });
    }
    if (path.parish) {
      list.push({
        label: path.parish,
        target: {
          continent: path.continent,
          country: path.country,
          region: path.region,
          district: path.district,
          districtId: path.districtId,
          subcounty: path.subcounty,
          subcountyId: path.subcountyId,
          parish: path.parish,
          parishId: path.parishId,
        },
      });
    }
    if (path.village) {
      list.push({
        label: path.village,
        target: path,
      });
    }
    return list;
  }, [path]);

  const cycleSortOrder = () => {
    setSortOrder((prev) =>
      prev === 'asc_active' ? 'desc' : prev === 'desc' ? ' alpha' : 'asc_active',
    );
  };

  const sortOrderLabel =
    sortOrder === 'asc_active'
      ? 'Requests: Ascending'
      : sortOrder === 'desc'
        ? 'Requests: High → Low'
        : 'Name: A → Z';

  const levelMeta = LEVEL_TITLES[level];

  return (
    <div className="space-y-3 sm:space-y-4 animate-in fade-in-50 duration-200">
      {/* Top Summary & Navigation Card */}
      <Card className="rounded-2xl border border-primary/25 bg-card shadow-xs overflow-hidden">
        <CardContent className="p-3.5 sm:p-5 space-y-3">
          {/* Row 1: Back Button on Left, Pending Count + Total UGX Pill on Right (always 1 row) */}
          <div className="flex items-center justify-between gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handleStepBack}
              className="a11y-exempt h-9 px-3 gap-1.5 rounded-xl text-xs sm:text-sm font-bold shrink-0"
            >
              <ArrowLeft className="h-4 w-4 shrink-0" />
              <span>Back</span>
            </Button>

            <div className="inline-flex items-center gap-2 rounded-full bg-primary/10 border border-primary/25 px-3 py-1.5 shrink-0">
              <span className="text-xs font-extrabold text-primary tabular-nums">
                {matchingRequests.length} pending
              </span>
              <span className="h-3 w-px bg-primary/25" />
              <span className="text-xs font-black text-foreground tabular-nums">
                {formatUGX(matchingTotalAmount)}
              </span>
            </div>
          </div>

          {/* Row 2: Single-Line Scrollable Breadcrumb Bar */}
          <div className="flex items-center gap-1 overflow-x-auto no-scrollbar rounded-xl bg-muted/50 border border-border/60 px-2.5 py-1.5 text-xs">
            <span
              role="button"
              tabIndex={0}
              onClick={onBackToHeroCard}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  onBackToHeroCard();
                }
              }}
              className="a11y-exempt inline-flex items-center gap-1 px-2 py-1 rounded-lg text-muted-foreground hover:text-foreground hover:bg-background/80 font-semibold whitespace-nowrap shrink-0 cursor-pointer transition-colors"
            >
              <Home className="h-3.5 w-3.5 shrink-0" />
              <span>Rent Requests</span>
            </span>
            {breadcrumbs.map((crumb, idx) => {
              const isLast = idx === breadcrumbs.length - 1;
              return (
                <div key={`${crumb.label}-${idx}`} className="inline-flex items-center gap-1 shrink-0">
                  <ChevronRight className="h-3.5 w-3.5 text-muted-foreground/60 shrink-0" />
                  <span
                    role="button"
                    tabIndex={0}
                    onClick={() => {
                      setSearchQuery('');
                      onPathChange(crumb.target);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        setSearchQuery('');
                        onPathChange(crumb.target);
                      }
                    }}
                    className={cn(
                      'a11y-exempt inline-flex items-center px-2.5 py-1 rounded-lg font-bold whitespace-nowrap shrink-0 cursor-pointer transition-colors',
                      isLast
                        ? 'bg-primary text-primary-foreground shadow-2xs'
                        : 'text-muted-foreground hover:text-foreground hover:bg-background/80',
                    )}
                  >
                    {crumb.label}
                  </span>
                </div>
              );
            })}
          </div>

          {/* Row 3: Step Title & Subtitle */}
          <div className="pt-0.5">
            <h3 className="text-base sm:text-lg font-extrabold tracking-tight text-foreground leading-snug">
              {levelMeta.title}
            </h3>
            <p className="text-xs text-muted-foreground leading-relaxed mt-0.5">
              {levelMeta.subtitle}
            </p>
          </div>

          {/* Row 4: Full-Width Search & Sort Controls (Stacked cleanly on mobile, side-by-side on desktop) */}
          {level !== 'leaf' && (
            <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2 pt-0.5">
              <div className="relative flex-1 min-w-0">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
                <Input
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder={`Search ${level}...`}
                  className="w-full h-10 pl-9 pr-9 text-sm bg-background rounded-xl border-border/80"
                />
                {searchQuery && (
                  <span
                    role="button"
                    tabIndex={0}
                    onClick={() => setSearchQuery('')}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        setSearchQuery('');
                      }
                    }}
                    className="a11y-exempt absolute right-2.5 top-1/2 -translate-y-1/2 p-1 text-muted-foreground hover:text-foreground cursor-pointer"
                  >
                    <X className="h-4 w-4" />
                  </span>
                )}
              </div>

              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={cycleSortOrder}
                className="a11y-exempt h-10 px-3.5 w-full sm:w-auto justify-between sm:justify-center gap-2 text-xs sm:text-sm font-semibold rounded-xl bg-background border-border/80 shrink-0"
                title="Change sort order"
              >
                <span className="inline-flex items-center gap-1.5">
                  <ArrowUpDown className="h-3.5 w-3.5 text-primary shrink-0" />
                  <span>{sortOrderLabel}</span>
                </span>
                <span className="text-[11px] text-muted-foreground sm:hidden">Tap to switch</span>
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Geographic Tiles Grid */}
      {level !== 'leaf' && (
        isLoadingLevel && tiles.length === 0 ? (
          <Card className="rounded-2xl border border-border/80 bg-card">
            <CardContent className="p-8 flex items-center justify-center gap-2.5 text-sm font-semibold text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin text-primary shrink-0" />
              <span>Loading official locations…</span>
            </CardContent>
          </Card>
        ) : (
          <div
            className={cn(
              'grid gap-2.5 sm:gap-3',
              level === 'continent'
                ? 'grid-cols-1 sm:grid-cols-3'
                : 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-3',
            )}
          >
            {tiles.map((tile) => {
              const hasRequests = tile.count > 0;
              return (
                <Card
                  key={tile.key}
                  role="button"
                  tabIndex={0}
                  onClick={() => handleTileSelect(tile)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      handleTileSelect(tile);
                    }
                  }}
                  className={cn(
                    'a11y-exempt rounded-2xl border transition-all duration-150 cursor-pointer select-none group overflow-hidden',
                    hasRequests
                      ? 'border-2 border-primary/50 bg-primary/5 shadow-sm hover:shadow-md hover:border-primary'
                      : 'border-border/80 bg-card hover:border-primary/40 hover:bg-muted/20',
                  )}
                >
                  <CardContent className="p-4 flex items-center justify-between gap-3">
                    {/* Left: Icon/Flag + Title + Subtitle */}
                    <div className="flex items-center gap-3 min-w-0 flex-1">
                      <div
                        className={cn(
                          'flex h-11 w-11 items-center justify-center rounded-xl shrink-0 text-lg font-bold',
                          hasRequests
                            ? 'bg-primary text-primary-foreground shadow-xs'
                            : 'bg-muted text-muted-foreground',
                        )}
                      >
                        {tile.emoji ? (
                          <span>{tile.emoji}</span>
                        ) : level === 'continent' ? (
                          <Globe className="h-5 w-5" />
                        ) : level === 'region' ? (
                          <Compass className="h-5 w-5" />
                        ) : level === 'district' ? (
                          <MapIcon className="h-5 w-5" />
                        ) : level === 'subcounty' ? (
                          <Building2 className="h-5 w-5" />
                        ) : level === 'parish' ? (
                          <Layers className="h-5 w-5" />
                        ) : (
                          <MapPin className="h-5 w-5" />
                        )}
                      </div>
                      <div className="min-w-0 flex-1">
                        <h4 className="text-sm sm:text-base font-extrabold tracking-tight text-foreground truncate group-hover:text-primary transition-colors">
                          {tile.label}
                        </h4>
                        {tile.subtitle && (
                          <p className="text-xs text-muted-foreground truncate mt-0.5">
                            {tile.subtitle}
                          </p>
                        )}
                      </div>
                    </div>

                    {/* Right: Pending Badge + Total UGX + Arrow */}
                    <div className="flex items-center gap-2.5 shrink-0">
                      <div className="text-right">
                        <span
                          className={cn(
                            'inline-flex items-center justify-center rounded-full px-2.5 py-0.5 text-[11px] font-extrabold tabular-nums',
                            hasRequests
                              ? 'bg-primary text-primary-foreground'
                              : 'bg-muted text-muted-foreground',
                          )}
                        >
                          {tile.count} pending
                        </span>
                        <p
                          className={cn(
                            'text-xs font-black tabular-nums mt-1',
                            hasRequests ? 'text-primary' : 'text-muted-foreground',
                          )}
                        >
                          {formatUGX(tile.amount)}
                        </p>
                      </div>
                      <ChevronRight className="h-4 w-4 text-muted-foreground group-hover:text-primary group-hover:translate-x-0.5 transition-all shrink-0" />
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )
      )}
    </div>
  );
}
