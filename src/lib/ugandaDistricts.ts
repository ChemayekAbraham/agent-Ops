/**
 * Uganda district normalization helpers.
 *
 * Backed by the `trg_normalize_profile_district` trigger on `profiles`:
 * Entebbe is a city under Wakiso District, so any UI that captures a
 * *district* value must rewrite "Entebbe" → "Wakiso" before submit.
 * Selecting Entebbe as a standalone district is not allowed.
 */

export const UGANDA_DISTRICTS = [
  // Central
  'Buikwe','Buvuma','Butambala','Gomba','Kalangala','Kalungu','Kampala','Kasanda',
  'Kayunga','Kiboga','Kyankwanzi','Kyotera','Luwero','Lwengo','Lyantonde','Masaka',
  'Mityana','Mpigi','Mubende','Mukono','Nakaseke','Nakasongola','Rakai','Sembabule','Wakiso',
  // Eastern
  'Amuria','Budaka','Bududa','Bugiri','Bugweri','Bukedea','Bukwo','Bulambuli','Busia',
  'Butaleja','Butebo','Buyende','Iganga','Jinja','Kaberamaido','Kaliro','Kapchorwa',
  'Kapelebyong','Katakwi','Kibuku','Kumi','Kween','Luuka','Manafwa','Mayuge','Mbale',
  'Namayingo','Namisindwa','Namutumba','Ngora','Pallisa','Serere','Sironko','Soroti','Tororo',
  // Northern
  'Abim','Adjumani','Agago','Alebtong','Amolatar','Amudat','Amuru','Apac','Arua','Dokolo',
  'Gulu','Kaabong','Karenga','Kitgum','Koboko','Kole','Kotido','Kwania','Lamwo','Lira',
  'Madi-Okollo','Maracha','Moroto','Moyo','Nabilatuk','Nakapiripirit','Napak','Nebbi',
  'Nwoya','Obongi','Omoro','Otuke','Oyam','Pader','Pakwach','Terego','Yumbe','Zombo',
  // Western
  'Buhweju','Buliisa','Bundibugyo','Bunyangabu','Bushenyi','Fort Portal','Hoima','Ibanda',
  'Isingiro','Kabale','Kabarole','Kagadi','Kakumiro','Kamwenge','Kanungu','Kasese','Kazo',
  'Kibaale','Kikuube','Kiruhura','Kiryandongo','Kisoro','Kitagwenda','Kyegegwa','Kyenjojo',
  'Masindi','Mbarara','Mitooma','Ntoroko','Ntungamo','Rubanda','Rubirizi','Rukiga',
  'Rukungiri','Rwampara','Sheema',
] as const;

/** Cities/suburbs that roll up to a parent district. */
export const CITY_TO_DISTRICT: Record<string, string> = {
  entebbe: 'Wakiso',
  nansana: 'Wakiso',
  kira: 'Wakiso',
  bweyogerere: 'Wakiso',
  kyengera: 'Wakiso',
};

export function normalizeDistrict(raw: string | null | undefined): string {
  if (!raw) return '';
  const cleaned = raw.trim();
  if (!cleaned) return '';
  const key = cleaned.toLowerCase();
  if (CITY_TO_DISTRICT[key]) return CITY_TO_DISTRICT[key];
  const match = UGANDA_DISTRICTS.find((d) => d.toLowerCase() === key);
  return match ?? cleaned;
}

/** Returns a friendly warning when the entered district is actually a city. */
export function districtWarning(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const key = raw.trim().toLowerCase();
  const parent = CITY_TO_DISTRICT[key];
  if (!parent) return null;
  const cityLabel = key.charAt(0).toUpperCase() + key.slice(1);
  return `${cityLabel} is a city under ${parent} District — saved as ${parent}.`;
}

/**
 * Display label for area/region pickers that mix districts and cities.
 * Cities are annotated with their parent district so users never confuse
 * a city (e.g. Entebbe) with a standalone district.
 */
export function regionLabel(value: string): string {
  const parent = CITY_TO_DISTRICT[value.trim().toLowerCase()];
  return parent ? `${value} (${parent})` : value;
}

/**
 * Uganda has 4 administrative regions. Many legacy records stored a
 * district or city in the `region` column (e.g. "Kampala", "Wakiso",
 * "Entebbe"). Map those back to the correct region so the hierarchy
 * picker shows ONE "Central", not five.
 */
export const UGANDA_REGIONS = ['Central', 'Eastern', 'Northern', 'Western'] as const;

const DISTRICT_TO_REGION: Record<string, typeof UGANDA_REGIONS[number]> = {
  // Central (incl. cities/suburbs that roll up)
  buikwe: 'Central', buvuma: 'Central', butambala: 'Central', gomba: 'Central',
  kalangala: 'Central', kalungu: 'Central', kampala: 'Central', kasanda: 'Central',
  kayunga: 'Central', kiboga: 'Central', kyankwanzi: 'Central', kyotera: 'Central',
  luwero: 'Central', lwengo: 'Central', lyantonde: 'Central', masaka: 'Central',
  mityana: 'Central', mpigi: 'Central', mubende: 'Central', mukono: 'Central',
  nakaseke: 'Central', nakasongola: 'Central', rakai: 'Central', sembabule: 'Central',
  wakiso: 'Central', entebbe: 'Central', nansana: 'Central', kira: 'Central',
  bweyogerere: 'Central', kyengera: 'Central',
  // Eastern
  amuria: 'Eastern', budaka: 'Eastern', bududa: 'Eastern', bugiri: 'Eastern',
  bugweri: 'Eastern', bukedea: 'Eastern', bukwo: 'Eastern', bulambuli: 'Eastern',
  busia: 'Eastern', butaleja: 'Eastern', butebo: 'Eastern', buyende: 'Eastern',
  iganga: 'Eastern', jinja: 'Eastern', kaberamaido: 'Eastern', kaliro: 'Eastern',
  kapchorwa: 'Eastern', kapelebyong: 'Eastern', katakwi: 'Eastern', kibuku: 'Eastern',
  kumi: 'Eastern', kween: 'Eastern', luuka: 'Eastern', manafwa: 'Eastern',
  mayuge: 'Eastern', mbale: 'Eastern', namayingo: 'Eastern', namisindwa: 'Eastern',
  namutumba: 'Eastern', ngora: 'Eastern', pallisa: 'Eastern', serere: 'Eastern',
  sironko: 'Eastern', soroti: 'Eastern', tororo: 'Eastern',
  // Northern
  abim: 'Northern', adjumani: 'Northern', agago: 'Northern', alebtong: 'Northern',
  amolatar: 'Northern', amudat: 'Northern', amuru: 'Northern', apac: 'Northern',
  arua: 'Northern', dokolo: 'Northern', gulu: 'Northern', kaabong: 'Northern',
  karenga: 'Northern', kitgum: 'Northern', koboko: 'Northern', kole: 'Northern',
  kotido: 'Northern', kwania: 'Northern', lamwo: 'Northern', lira: 'Northern',
  'madi-okollo': 'Northern', maracha: 'Northern', moroto: 'Northern', moyo: 'Northern',
  nabilatuk: 'Northern', nakapiripirit: 'Northern', napak: 'Northern', nebbi: 'Northern',
  nwoya: 'Northern', obongi: 'Northern', omoro: 'Northern', otuke: 'Northern',
  oyam: 'Northern', pader: 'Northern', pakwach: 'Northern', terego: 'Northern',
  yumbe: 'Northern', zombo: 'Northern',
  // Western
  buhweju: 'Western', buliisa: 'Western', bundibugyo: 'Western', bunyangabu: 'Western',
  bushenyi: 'Western', 'fort portal': 'Western', hoima: 'Western', ibanda: 'Western',
  isingiro: 'Western', kabale: 'Western', kabarole: 'Western', kagadi: 'Western',
  kakumiro: 'Western', kamwenge: 'Western', kanungu: 'Western', kasese: 'Western',
  kazo: 'Western', kibaale: 'Western', kikuube: 'Western', kiruhura: 'Western',
  kiryandongo: 'Western', kisoro: 'Western', kitagwenda: 'Western', kyegegwa: 'Western',
  kyenjojo: 'Western', masindi: 'Western', mbarara: 'Western', mitooma: 'Western',
  ntoroko: 'Western', ntungamo: 'Western', rubanda: 'Western', rubirizi: 'Western',
  rukiga: 'Western', rukungiri: 'Western', rwampara: 'Western', sheema: 'Western',
};

export function normalizeUgandaRegion(raw: string | null | undefined): string {
  if (!raw) return 'Unknown region';
  const cleaned = raw.trim();
  if (!cleaned) return 'Unknown region';
  const key = cleaned.toLowerCase().replace(/\s+region$/, '').trim();
  // Already a valid region (case-insensitive)
  const direct = UGANDA_REGIONS.find((r) => r.toLowerCase() === key);
  if (direct) return direct;
  return DISTRICT_TO_REGION[key] ?? cleaned;
}

/**
 * UI grouping of Uganda into its 4 official administrative regions
 * (Central, Eastern, Western, Northern). Southern districts like
 * Masaka, Rakai, Kabale, Kisoro etc. live under their canonical
 * region (Central or Western) — they are NOT split into a separate
 * "Southern" bucket, otherwise the same tenants would be double-
 * counted across Central and Southern.
 */
export interface UgandaDistrictEntry {
  name: string;
  /** Canonical region stored in the database (Central/Eastern/Northern/Western). */
  backendRegion: typeof UGANDA_REGIONS[number];
}

export interface UgandaRegionGroup {
  /** Label shown in the UI (e.g. "Central Uganda"). */
  label: string;
  /** Short key for state. */
  key: 'central' | 'eastern' | 'western' | 'northern' | 'southern';
  districts: UgandaDistrictEntry[];
}

export const UGANDA_REGION_GROUPS: UgandaRegionGroup[] = [
  {
    label: 'Central Uganda',
    key: 'central',
    districts: [
      { name: 'Buikwe', backendRegion: 'Central' },
      { name: 'Buvuma', backendRegion: 'Central' },
      { name: 'Butambala', backendRegion: 'Central' },
      { name: 'Gomba', backendRegion: 'Central' },
      { name: 'Kampala', backendRegion: 'Central' },
      { name: 'Kasanda', backendRegion: 'Central' },
      { name: 'Kayunga', backendRegion: 'Central' },
      { name: 'Kiboga', backendRegion: 'Central' },
      { name: 'Kyankwanzi', backendRegion: 'Central' },
      { name: 'Luwero', backendRegion: 'Central' },
      { name: 'Mityana', backendRegion: 'Central' },
      { name: 'Mpigi', backendRegion: 'Central' },
      { name: 'Mubende', backendRegion: 'Central' },
      { name: 'Mukono', backendRegion: 'Central' },
      { name: 'Nakaseke', backendRegion: 'Central' },
      { name: 'Nakasongola', backendRegion: 'Central' },
      { name: 'Wakiso', backendRegion: 'Central' },
    ],
  },
  {
    label: 'Eastern Uganda',
    key: 'eastern',
    districts: [
      { name: 'Amuria', backendRegion: 'Eastern' },
      { name: 'Budaka', backendRegion: 'Eastern' },
      { name: 'Bududa', backendRegion: 'Eastern' },
      { name: 'Bugiri', backendRegion: 'Eastern' },
      { name: 'Bugweri', backendRegion: 'Eastern' },
      { name: 'Bukedea', backendRegion: 'Eastern' },
      { name: 'Bukwo', backendRegion: 'Eastern' },
      { name: 'Bulambuli', backendRegion: 'Eastern' },
      { name: 'Busia', backendRegion: 'Eastern' },
      { name: 'Butaleja', backendRegion: 'Eastern' },
      { name: 'Butebo', backendRegion: 'Eastern' },
      { name: 'Buyende', backendRegion: 'Eastern' },
      { name: 'Iganga', backendRegion: 'Eastern' },
      { name: 'Jinja', backendRegion: 'Eastern' },
      { name: 'Kaberamaido', backendRegion: 'Eastern' },
      { name: 'Kaliro', backendRegion: 'Eastern' },
      { name: 'Kapchorwa', backendRegion: 'Eastern' },
      { name: 'Kapelebyong', backendRegion: 'Eastern' },
      { name: 'Katakwi', backendRegion: 'Eastern' },
      { name: 'Kibuku', backendRegion: 'Eastern' },
      { name: 'Kumi', backendRegion: 'Eastern' },
      { name: 'Kween', backendRegion: 'Eastern' },
      { name: 'Luuka', backendRegion: 'Eastern' },
      { name: 'Manafwa', backendRegion: 'Eastern' },
      { name: 'Mayuge', backendRegion: 'Eastern' },
      { name: 'Mbale', backendRegion: 'Eastern' },
      { name: 'Namayingo', backendRegion: 'Eastern' },
      { name: 'Namisindwa', backendRegion: 'Eastern' },
      { name: 'Namutumba', backendRegion: 'Eastern' },
      { name: 'Ngora', backendRegion: 'Eastern' },
      { name: 'Pallisa', backendRegion: 'Eastern' },
      { name: 'Serere', backendRegion: 'Eastern' },
      { name: 'Sironko', backendRegion: 'Eastern' },
      { name: 'Soroti', backendRegion: 'Eastern' },
      { name: 'Tororo', backendRegion: 'Eastern' },
    ],
  },
  {
    label: 'Western Uganda',
    key: 'western',
    districts: [
      { name: 'Buhweju', backendRegion: 'Western' },
      { name: 'Buliisa', backendRegion: 'Western' },
      { name: 'Bundibugyo', backendRegion: 'Western' },
      { name: 'Bunyangabu', backendRegion: 'Western' },
      { name: 'Bushenyi', backendRegion: 'Western' },
      { name: 'Fort Portal', backendRegion: 'Western' },
      { name: 'Hoima', backendRegion: 'Western' },
      { name: 'Ibanda', backendRegion: 'Western' },
      { name: 'Isingiro', backendRegion: 'Western' },
      { name: 'Kabarole', backendRegion: 'Western' },
      { name: 'Kagadi', backendRegion: 'Western' },
      { name: 'Kakumiro', backendRegion: 'Western' },
      { name: 'Kamwenge', backendRegion: 'Western' },
      { name: 'Kasese', backendRegion: 'Western' },
      { name: 'Kazo', backendRegion: 'Western' },
      { name: 'Kibaale', backendRegion: 'Western' },
      { name: 'Kikuube', backendRegion: 'Western' },
      { name: 'Kiruhura', backendRegion: 'Western' },
      { name: 'Kiryandongo', backendRegion: 'Western' },
      { name: 'Kitagwenda', backendRegion: 'Western' },
      { name: 'Kyegegwa', backendRegion: 'Western' },
      { name: 'Kyenjojo', backendRegion: 'Western' },
      { name: 'Masindi', backendRegion: 'Western' },
      { name: 'Mbarara', backendRegion: 'Western' },
      { name: 'Mitooma', backendRegion: 'Western' },
      { name: 'Ntoroko', backendRegion: 'Western' },
      { name: 'Rubirizi', backendRegion: 'Western' },
      { name: 'Rwampara', backendRegion: 'Western' },
      { name: 'Sheema', backendRegion: 'Western' },
    ],
  },
  {
    label: 'Northern Uganda',
    key: 'northern',
    districts: [
      { name: 'Abim', backendRegion: 'Northern' },
      { name: 'Adjumani', backendRegion: 'Northern' },
      { name: 'Agago', backendRegion: 'Northern' },
      { name: 'Alebtong', backendRegion: 'Northern' },
      { name: 'Amolatar', backendRegion: 'Northern' },
      { name: 'Amudat', backendRegion: 'Northern' },
      { name: 'Amuru', backendRegion: 'Northern' },
      { name: 'Apac', backendRegion: 'Northern' },
      { name: 'Arua', backendRegion: 'Northern' },
      { name: 'Dokolo', backendRegion: 'Northern' },
      { name: 'Gulu', backendRegion: 'Northern' },
      { name: 'Kaabong', backendRegion: 'Northern' },
      { name: 'Karenga', backendRegion: 'Northern' },
      { name: 'Kitgum', backendRegion: 'Northern' },
      { name: 'Koboko', backendRegion: 'Northern' },
      { name: 'Kole', backendRegion: 'Northern' },
      { name: 'Kotido', backendRegion: 'Northern' },
      { name: 'Kwania', backendRegion: 'Northern' },
      { name: 'Lamwo', backendRegion: 'Northern' },
      { name: 'Lira', backendRegion: 'Northern' },
      { name: 'Madi-Okollo', backendRegion: 'Northern' },
      { name: 'Maracha', backendRegion: 'Northern' },
      { name: 'Moroto', backendRegion: 'Northern' },
      { name: 'Moyo', backendRegion: 'Northern' },
      { name: 'Nabilatuk', backendRegion: 'Northern' },
      { name: 'Nakapiripirit', backendRegion: 'Northern' },
      { name: 'Napak', backendRegion: 'Northern' },
      { name: 'Nebbi', backendRegion: 'Northern' },
      { name: 'Nwoya', backendRegion: 'Northern' },
      { name: 'Obongi', backendRegion: 'Northern' },
      { name: 'Omoro', backendRegion: 'Northern' },
      { name: 'Otuke', backendRegion: 'Northern' },
      { name: 'Oyam', backendRegion: 'Northern' },
      { name: 'Pader', backendRegion: 'Northern' },
      { name: 'Pakwach', backendRegion: 'Northern' },
      { name: 'Terego', backendRegion: 'Northern' },
      { name: 'Yumbe', backendRegion: 'Northern' },
      { name: 'Zombo', backendRegion: 'Northern' },
    ],
  },
  {
    label: 'Southern Uganda',
    key: 'southern',
    districts: [
      // Greater Masaka sub-region (backend stores them as Central)
      { name: 'Kalangala', backendRegion: 'Central' },
      { name: 'Kalungu', backendRegion: 'Central' },
      { name: 'Kyotera', backendRegion: 'Central' },
      { name: 'Lwengo', backendRegion: 'Central' },
      { name: 'Lyantonde', backendRegion: 'Central' },
      { name: 'Masaka', backendRegion: 'Central' },
      { name: 'Rakai', backendRegion: 'Central' },
      { name: 'Sembabule', backendRegion: 'Central' },
      // Kigezi sub-region (backend stores them as Western)
      { name: 'Kabale', backendRegion: 'Western' },
      { name: 'Kanungu', backendRegion: 'Western' },
      { name: 'Kisoro', backendRegion: 'Western' },
      { name: 'Rubanda', backendRegion: 'Western' },
      { name: 'Rukiga', backendRegion: 'Western' },
      { name: 'Rukungiri', backendRegion: 'Western' },
      { name: 'Ntungamo', backendRegion: 'Western' },
    ],
  },
];

/**
 * Curated administrative areas (sub-counties, town councils, municipal
 * divisions, city divisions) for each Uganda district. Used by the
 * Tenant Location Browser so that drilling into a district shows EVERY
 * official area — not just the ones with tenants already on the
 * platform. Areas with users are highlighted in purple at render time.
 *
 * Only districts with a curated entry get the rich picker; others fall
 * back to the live-only ward tile grid.
 */
export const UGANDA_DISTRICT_AREAS: Record<string, string[]> = {
  Kampala: [
    // ── The 5 KCCA City Divisions ──
    'Central Division',
    'Kawempe Division',
    'Makindye Division',
    'Nakawa Division',
    'Rubaga Division',
    // ── Central Division — parishes / wards ──
    'Bukesa',
    'Civic Centre',
    'Industrial Area',
    'Kagugube',
    'Kamwokya I',
    'Kisenyi I',
    'Kisenyi II',
    'Kisenyi III',
    'Kololo I',
    'Kololo II',
    'Kololo III',
    'Kololo IV',
    'Mengo',
    'Nakasero I',
    'Nakasero II',
    'Nakasero III',
    'Nakasero IV',
    'Nakivubo',
    'Old Kampala',
    // ── Kawempe Division — parishes / wards ──
    'Bwaise I',
    'Bwaise II',
    'Bwaise III',
    'Kalerwe',
    'Kanyanya',
    'Kawempe I',
    'Kawempe II',
    'Kazo',
    'Komamboga',
    'Kyebando',
    'Makerere I',
    'Makerere II',
    'Makerere III',
    'Mpererwe',
    'Mulago I',
    'Mulago II',
    'Mulago III',
    'Nsooba',
    // ── Makindye Division — parishes / wards ──
    'Bukasa',
    'Buziga',
    'Ggaba',
    'Kabalagala',
    'Kansanga',
    'Katwe I',
    'Katwe II',
    'Kibuli',
    'Kibuye I',
    'Kibuye II',
    'Lukuli',
    'Luwafu',
    'Makindye I',
    'Makindye II',
    'Nsambya Central',
    'Nsambya Estate',
    'Nsambya Railways',
    'Salaama',
    'Wabigalo',
    // ── Nakawa Division — parishes / wards ──
    'Banda',
    'Bugolobi',
    'Butabika',
    'Kanyanya (Nakawa)',
    'Kiswa',
    'Kitintale',
    'Kyambogo',
    'Luzira',
    'Mbuya I',
    'Mbuya II',
    'Mutungo',
    'Naguru I',
    'Naguru II',
    'Nakawa',
    'Ntinda',
    // ── Rubaga (Lubaga) Division — parishes / wards ──
    'Busega',
    'Kasubi',
    'Kawaala',
    'Lubaga',
    'Lubya',
    'Lungujja',
    'Mutundwe',
    'Najjanankumbi I',
    'Najjanankumbi II',
    'Nakulabye',
    'Namirembe',
    'Namungoona',
    'Nateete',
    'Ndeeba',
  ],
  Wakiso: [
    // Entebbe Municipality
    'Entebbe Division A',
    'Entebbe Division B',
    // Nansana Municipality
    'Nansana Division',
    'Nabweru Division',
    'Gombe Division',
    'Busukuma Division',
    // Kira Municipality
    'Kira Division',
    'Bweyogerere Division',
    'Namugongo Division',
    // Makindye-Ssabagabo Municipality
    'Bunamwaya Division',
    'Masajja Division',
    'Ndejje Division',
    // Sub-counties / Town Councils
    'Wakiso Town Council',
    'Kasangati Town Council',
    'Kyengera Town Council',
    'Katabi Town Council',
    'Kakiri Town Council',
    'Masulita Town Council',
    'Namayumba Town Council',
    'Nsangi',
    'Ssisa',
    'Kasanje',
    'Mende',
    'Nangabo',
    'Wakiso',
  ],
};