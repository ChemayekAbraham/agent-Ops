import { describe, expect, it } from 'vitest';
import { signageGpsLocation } from '@/lib/signageGpsLocation';
import { mergeOfficialChain, resolveDistricts, searchTokens, type AdminUnit, type CountyUnit } from '@/lib/signageOfficialLocation';

/**
 * Nationwide check: 16 real cells across all four regions (rural counties, municipalities, Kampala
 * divisions, town councils), each with an OpenStreetMap-style answer using the spellings geocoders
 * send ("Luwero", "Sembabule", "Gulu City"), and the exact rows the official dataset returns for the
 * app's keyword search (captured from production, 2026-11-13).
 */
const D: AdminUnit[] = [
  { id: 2, name: 'Arua' }, { id: 5, name: 'Gulu' }, { id: 8, name: 'Jinja' }, { id: 10, name: 'Kabarole' },
  { id: 32, name: 'Kampala' }, { id: 44, name: 'Kasese' }, { id: 51, name: 'Lira' }, { id: 52, name: 'Luweero' },
  { id: 134, name: 'Madi-Okollo' }, { id: 53, name: 'Masaka' }, { id: 55, name: 'Mbale' }, { id: 56, name: 'Mbarara' },
  { id: 60, name: 'Mukono' }, { id: 73, name: 'Ssembabule' }, { id: 80, name: 'Wakiso' },
  { id: 132, name: 'Kazo' }, { id: 93, name: 'Kiruhura' }, { id: 137, name: 'Rwampara' }, { id: 38, name: 'Kasanda' },
];
const d = (name: string) => D.find((x) => x.name === name)!;
const C: CountyUnit[] = ([
  ['Terego East County', 'Arua'], ['Upper Madi County', 'Arua'], ['Upper Madi County', 'Madi-Okollo'],
  ['Gulu Municipality', 'Gulu'], ['Jinja Municipality East', 'Jinja'], ['Fort Portal Municipality', 'Kabarole'],
  ['Nakawa Division', 'Kampala'], ['Kampala Central Division', 'Kampala'], ['Lira Municipality', 'Lira'],
  ['Masaka Municipality', 'Masaka'], ['Mbale Municipality', 'Mbale'], ['Mbarara Municipality', 'Mbarara'],
  ['Rwampara County', 'Mbarara'], ['Rwampara County', 'Rwampara'], ['Mukono Municipality', 'Mukono'],
  ['Mawogola County', 'Ssembabule'], ['Entebbe Municipality', 'Wakiso'], ['Kira Municipality', 'Wakiso'],
  ['Makindye-Ssabagabo Municipality', 'Wakiso'], ['Kazo County', 'Kazo'], ['Kazo County', 'Kiruhura'],
  ['Kassanda County North', 'Kasanda'],
] as const).map(([name, dn]) => ({ name, district: d(dn) }));

type Case = [label: string, osm: Record<string, string>, expected: (string | '')[], rows: string[][]];
// expected: district / county / sub-county / parish / village ('' = left blank because the dataset is ambiguous).
const CASES: Case[] = [
  ['Arua/Terego rural', {country_code:'ug', county:'Terego', village:'Opira'},
    ["Arua", "Terego East County", "Odupi", "", "OPIRA"],
    [["OPIRA", "Azaapi", "Odupi", "Terego East County", "Arua"], ["OPIRA", "Otumbari", "Odupi", "Terego East County", "Arua"]]],
  ['Gulu City', {country_code:'ug', city:'Gulu City', city_district:'Pece Division', suburb:'Pawel', village:'Pudyek'},
    ["Gulu", "Gulu Municipality", "Pece", "Pawel", "PUDYEK"],
    [["AKWI", "Pawel", "Patiko", "Aswa County", "Gulu"], ["ANGANY", "Pawel", "Patiko", "Aswa County", "Gulu"], ["TELADWONG", "Pawel", "Patiko", "Aswa County", "Gulu"], ["TULALIYA", "Pawel", "Patiko", "Aswa County", "Gulu"], ["FOREST", "Pece Prisons", "Laroo", "Gulu Municipality", "Gulu"], ["LUKUNG", "Pece Prisons", "Laroo", "Gulu Municipality", "Gulu"], ["PECE PRISON", "Pece Prisons", "Laroo", "Gulu Municipality", "Gulu"], ["CUBU ACOYO", "Pawel", "Pece", "Gulu Municipality", "Gulu"], ["PAWEL CENTRAL", "Pawel", "Pece", "Gulu Municipality", "Gulu"], ["PUDYEK", "Pawel", "Pece", "Gulu Municipality", "Gulu"]]],
  ['Jinja City', {country_code:'ug', city:'Jinja City', suburb:'Walukuba', neighbourhood:'Works'},
    ["Jinja", "Jinja Municipality East", "Walukuba/Masese", "Walukuba West", "WORKS"],
    [["CENTRAL", "Walukuba East", "Walukuba/Masese", "Jinja Municipality East", "Jinja"], ["CHURCH", "Walukuba East", "Walukuba/Masese", "Jinja Municipality East", "Jinja"], ["NTEGE", "Walukuba East", "Walukuba/Masese", "Jinja Municipality East", "Jinja"], ["POLICE WING", "Walukuba East", "Walukuba/Masese", "Jinja Municipality East", "Jinja"], ["SCHOOL", "Walukuba East", "Walukuba/Masese", "Jinja Municipality East", "Jinja"], ["STEEL", "Walukuba East", "Walukuba/Masese", "Jinja Municipality East", "Jinja"], ["BABU", "Walukuba West", "Walukuba/Masese", "Jinja Municipality East", "Jinja"], ["FACTORY", "Walukuba West", "Walukuba/Masese", "Jinja Municipality East", "Jinja"], ["JROP", "Walukuba West", "Walukuba/Masese", "Jinja Municipality East", "Jinja"], ["KLMN", "Walukuba West", "Walukuba/Masese", "Jinja Municipality East", "Jinja"], ["MATERNITY", "Walukuba West", "Walukuba/Masese", "Jinja Municipality East", "Jinja"], ["RAILWAYS", "Walukuba West", "Walukuba/Masese", "Jinja Municipality East", "Jinja"], ["WORKS", "Walukuba West", "Walukuba/Masese", "Jinja Municipality East", "Jinja"], ["ZABEF", "Walukuba West", "Walukuba/Masese", "Jinja Municipality East", "Jinja"]]],
  ['Fort Portal City', {country_code:'ug', city:'Fort Portal Tourism City', suburb:'Kasusu', village:'Kasusu B'},
    ["Kabarole", "Fort Portal Municipality", "Southern Division", "Kasusu", "KASUSU B"],
    [["ISEKAHUNGU", "Kasusu", "Southern Division", "Fort Portal Municipality", "Kabarole"], ["KASUSU  A", "Kasusu", "Southern Division", "Fort Portal Municipality", "Kabarole"], ["KASUSU  B", "Kasusu", "Southern Division", "Fort Portal Municipality", "Kabarole"], ["KASUSU  C", "Kasusu", "Southern Division", "Fort Portal Municipality", "Kabarole"], ["KIDUKURU/KIHEMBO (A)", "Kasusu", "Southern Division", "Fort Portal Municipality", "Kabarole"], ["KIDUKURU/KIHEMBO (B)", "Kasusu", "Southern Division", "Fort Portal Municipality", "Kabarole"], ["NSORRO  A", "Kasusu", "Southern Division", "Fort Portal Municipality", "Kabarole"], ["NSORRO  B", "Kasusu", "Southern Division", "Fort Portal Municipality", "Kabarole"]]],
  ['Kampala Nakawa', {country_code:'ug', county:'Kampala Capital City', city:'Kampala', city_district:'Nakawa Division', suburb:'Bukoto', neighbourhood:'Mulimira'},
    ["Kampala", "Nakawa Division", "Nakawa", "Bukoto I", "MULIMIRA"],
    [["KALONDA", "Bukoto I", "Nakawa", "Nakawa Division", "Kampala"], ["KATENDE", "Bukoto I", "Nakawa", "Nakawa Division", "Kampala"], ["KEZIRONI", "Bukoto I", "Nakawa", "Nakawa Division", "Kampala"], ["MAKONZI", "Bukoto I", "Nakawa", "Nakawa Division", "Kampala"], ["MASALANI", "Bukoto I", "Nakawa", "Nakawa Division", "Kampala"], ["MOWLEM", "Bukoto I", "Nakawa", "Nakawa Division", "Kampala"], ["MUKALAZI", "Bukoto I", "Nakawa", "Nakawa Division", "Kampala"], ["MULIMIRA", "Bukoto I", "Nakawa", "Nakawa Division", "Kampala"], ["NAMULI", "Bukoto I", "Nakawa", "Nakawa Division", "Kampala"], ["OLD KIIRA ROAD", "Bukoto I", "Nakawa", "Nakawa Division", "Kampala"], ["SEMWOGERERE", "Bukoto I", "Nakawa", "Nakawa Division", "Kampala"], ["SSEMPIJJA", "Bukoto I", "Nakawa", "Nakawa Division", "Kampala"], ["UCB", "Bukoto I", "Nakawa", "Nakawa Division", "Kampala"], ["BBUYE CENTRAL", "Bukoto Ii", "Nakawa", "Nakawa Division", "Kampala"], ["BUKENYA", "Bukoto Ii", "Nakawa", "Nakawa Division", "Kampala"], ["BUTUKIRWA", "Bukoto Ii", "Nakawa", "Nakawa Division", "Kampala"], ["KALINABIRI  I", "Bukoto Ii", "Nakawa", "Nakawa Division", "Kampala"], ["KALINABIRI  II", "Bukoto Ii", "Nakawa", "Nakawa Division", "Kampala"], ["KIGOWA  I", "Bukoto Ii", "Nakawa", "Nakawa Division", "Kampala"], ["KIGOWA  II", "Bukoto Ii", "Nakawa", "Nakawa Division", "Kampala"], ["KINAWATAKA", "Bukoto Ii", "Nakawa", "Nakawa Division", "Kampala"], ["MUTOOLA", "Bukoto Ii", "Nakawa", "Nakawa Division", "Kampala"], ["NSIMBI ZIWOME", "Bukoto Ii", "Nakawa", "Nakawa Division", "Kampala"], ["SEMPAGALA", "Bukoto Ii", "Nakawa", "Nakawa Division", "Kampala"], ["UEB", "Bukoto Ii", "Nakawa", "Nakawa Division", "Kampala"], ["MIWANDA", "Nakawa", "Nakawa", "Nakawa Division", "Kampala"], ["NSIMBE KASI", "Nakawa", "Nakawa", "Nakawa Division", "Kampala"], ["SENTAMU KAVULE", "Nakawa", "Nakawa", "Nakawa Division", "Kampala"], ["EAST VILLAGE", "Nakawa Institutions", "Nakawa", "Nakawa Division", "Kampala"], ["MUBS 602", "Nakawa Institutions", "Nakawa", "Nakawa Division", "Kampala"], ["VOCATIONAL", "Nakawa Institutions", "Nakawa", "Nakawa Division", "Kampala"]]],
  ['Kasese rural', {country_code:'ug', county:'Kasese', village:'Nyabirongo'},
    ["Kasese", "Bukonzo County East", "", "", "Nyabirongo"],
    [["BUGHEMA", "Nyabirongo", "Kisinga", "Bukonzo County  East", "Kasese"], ["BUSINE", "Nyabirongo", "Kisinga", "Bukonzo County  East", "Kasese"], ["BUSYANGWA", "Nyabirongo", "Kisinga", "Bukonzo County  East", "Kasese"], ["KAMAHANGA", "Nyabirongo", "Kisinga", "Bukonzo County  East", "Kasese"], ["KAMUGHOBE I", "Nyabirongo", "Kisinga", "Bukonzo County  East", "Kasese"], ["NDANDU", "Nyabirongo", "Kisinga", "Bukonzo County  East", "Kasese"], ["NYABIRONGO I", "Nyabirongo", "Kisinga", "Bukonzo County  East", "Kasese"], ["NYABIRONGO II", "Nyabirongo", "Kisinga", "Bukonzo County  East", "Kasese"], ["BUTHWE", "Nyabirongo Ward", "Kisinga Town Council", "Bukonzo County  East", "Kasese"], ["NYABIRONGO  CENTRAL", "Nyabirongo Ward", "Kisinga Town Council", "Bukonzo County  East", "Kasese"], ["NYAKAINA", "Nyabirongo Ward", "Kisinga Town Council", "Bukonzo County  East", "Kasese"]]],
  ['Lira City', {country_code:'ug', city:'Lira City', city_district:'Adyel Division', suburb:'Teso', village:'Kulu Ahali'},
    ["Lira", "Lira Municipality", "Adyel", "Teso C", "KULU AHALI"],
    [["KULU-OBIA", "Okio", "Ayami", "Erute County North", "Lira"], ["TEKULU", "Adwoa", "Ogur", "Erute County North", "Lira"], ["ADYELOWANGO", "Akor", "Ogur", "Erute County North", "Lira"], ["ADYEL", "Onyakede", "Amach Town Council", "Erute County South", "Lira"], ["CORNER KAMDINI", "Teso   A", "Adyel", "Lira Municipality", "Lira"], ["LIRA MODERN", "Teso   A", "Adyel", "Lira Municipality", "Lira"], ["MEDICAL QUARTERS", "Teso   A", "Adyel", "Lira Municipality", "Lira"], ["AMBALAL", "Teso   C", "Adyel", "Lira Municipality", "Lira"], ["KULU AHALI", "Teso   C", "Adyel", "Lira Municipality", "Lira"], ["TEKULU", "Ipito-Aweno", "Ojwina", "Lira Municipality", "Lira"]]],
  ['Luwero (spelling)', {country_code:'ug', county:'Luwero', suburb:'Sekamuli', village:'Nakulabye'},
    ["Luweero", "Bamunanika County", "Bamunanika", "Sekamuli", "NAKULABYE"],
    [["KAKOOLA", "Sekamuli", "Bamunanika", "Bamunanika County", "Luweero"], ["KASIRIBIITI", "Sekamuli", "Bamunanika", "Bamunanika County", "Luweero"], ["KITTO", "Sekamuli", "Bamunanika", "Bamunanika County", "Luweero"], ["MPUTTE", "Sekamuli", "Bamunanika", "Bamunanika County", "Luweero"], ["NAKULABYE", "Sekamuli", "Bamunanika", "Bamunanika County", "Luweero"], ["NAMAKOFU", "Sekamuli", "Bamunanika", "Bamunanika County", "Luweero"], ["NDABIRAAKODDALA", "Sekamuli", "Bamunanika", "Bamunanika County", "Luweero"], ["SEKAMULI", "Sekamuli", "Bamunanika", "Bamunanika County", "Luweero"], ["WABIYINJA", "Sekamuli", "Bamunanika", "Bamunanika County", "Luweero"], ["WANTULA", "Sekamuli", "Bamunanika", "Bamunanika County", "Luweero"]]],
  ['Madi-Okollo', {country_code:'ug', county:'Madi Okollo District', village:'Omuriba'},
    ["Madi-Okollo", "Upper Madi County", "Anyiribu", "Bondo", "OMURIBA"],
    [["OMURIBA", "Bondo", "Anyiribu", "Upper Madi County", "Madi-Okollo"]]],
  ['Masaka City', {country_code:'ug', city:'Masaka City', suburb:'Kyabakuza', neighbourhood:'Mwalo'},
    ["Masaka", "Masaka Municipality", "Kimaanya/Kyabakuza", "Kyabakuza", "MWALO"],
    [["GAYAAZA", "Kyabakuza", "Kimaanya/Kyabakuza", "Masaka Municipality", "Masaka"], ["KYABAKUZA  A", "Kyabakuza", "Kimaanya/Kyabakuza", "Masaka Municipality", "Masaka"], ["KYABAKUZA  B", "Kyabakuza", "Kimaanya/Kyabakuza", "Masaka Municipality", "Masaka"], ["KYABAKUZA  T.C", "Kyabakuza", "Kimaanya/Kyabakuza", "Masaka Municipality", "Masaka"], ["MWALO", "Kyabakuza", "Kimaanya/Kyabakuza", "Masaka Municipality", "Masaka"]]],
  ['Mbale City', {country_code:'ug', city:'Mbale City', city_district:'Northern Division', suburb:'Nkoma', village:'Buyonjo'},
    ["Mbale", "Mbale Municipality", "Northern Borough", "Nkoma", "BUYONJO"],
    [["BUDI B", "Nkoma", "Namanyonyi", "Bungokho County North", "Mbale"], ["KANIKWA A", "Nkoma", "Namanyonyi", "Bungokho County North", "Mbale"], ["KANIKWA B", "Nkoma", "Namanyonyi", "Bungokho County North", "Mbale"], ["KINYOLI A", "Nkoma", "Namanyonyi", "Bungokho County North", "Mbale"], ["KINYOLI B", "Nkoma", "Namanyonyi", "Bungokho County North", "Mbale"], ["NABUNYIRI", "Nkoma", "Namanyonyi", "Bungokho County North", "Mbale"], ["NAMANYONYI CENTRE A", "Nkoma", "Namanyonyi", "Bungokho County North", "Mbale"], ["NAMANYONYI CENTRE B", "Nkoma", "Namanyonyi", "Bungokho County North", "Mbale"], ["NAMATALA ZONE", "Nkoma", "Namanyonyi", "Bungokho County North", "Mbale"], ["NANSU", "Nkoma", "Namanyonyi", "Bungokho County North", "Mbale"], ["NDEEGA", "Nkoma", "Namanyonyi", "Bungokho County North", "Mbale"], ["NKOMA CENTRE A", "Nkoma", "Namanyonyi", "Bungokho County North", "Mbale"], ["NKOMA CENTRE B", "Nkoma", "Namanyonyi", "Bungokho County North", "Mbale"], ["BUJOLOTO", "Nkoma", "Northern Borough", "Mbale Municipality", "Mbale"], ["BUYONJO", "Nkoma", "Northern Borough", "Mbale Municipality", "Mbale"], ["GANGAMA", "Nkoma", "Northern Borough", "Mbale Municipality", "Mbale"], ["HYGIENE", "Nkoma", "Northern Borough", "Mbale Municipality", "Mbale"], ["NAMBOZO", "Nkoma", "Northern Borough", "Mbale Municipality", "Mbale"], ["SENKULU", "Nkoma", "Northern Borough", "Mbale Municipality", "Mbale"], ["WAGAGAI", "Nkoma", "Northern Borough", "Mbale Municipality", "Mbale"], ["WANAMBWA", "Nkoma", "Northern Borough", "Mbale Municipality", "Mbale"]]],
  ['Mbarara City', {country_code:'ug', city:'Mbarara City', suburb:'Rwakishakizi', village:'Rwakishakizi II'},
    ["Mbarara", "Mbarara Municipality", "Nyakayojo", "Rwakishakizi Ward", "RWAKISHAKIZI II"],
    [["BWIGARA", "Rwakishakizi Ward", "Nyakayojo", "Mbarara Municipality", "Mbarara"], ["KAGASHA", "Rwakishakizi Ward", "Nyakayojo", "Mbarara Municipality", "Mbarara"], ["KARAMA I", "Rwakishakizi Ward", "Nyakayojo", "Mbarara Municipality", "Mbarara"], ["KARAMA II", "Rwakishakizi Ward", "Nyakayojo", "Mbarara Municipality", "Mbarara"], ["KAYONZA", "Rwakishakizi Ward", "Nyakayojo", "Mbarara Municipality", "Mbarara"], ["KIBINGO", "Rwakishakizi Ward", "Nyakayojo", "Mbarara Municipality", "Mbarara"], ["MISYAMO", "Rwakishakizi Ward", "Nyakayojo", "Mbarara Municipality", "Mbarara"], ["NSHUNGYEZI", "Rwakishakizi Ward", "Nyakayojo", "Mbarara Municipality", "Mbarara"], ["NYAKASA", "Rwakishakizi Ward", "Nyakayojo", "Mbarara Municipality", "Mbarara"], ["RUCECE", "Rwakishakizi Ward", "Nyakayojo", "Mbarara Municipality", "Mbarara"], ["RUCENCE", "Rwakishakizi Ward", "Nyakayojo", "Mbarara Municipality", "Mbarara"], ["RWAKISHAKIZI I", "Rwakishakizi Ward", "Nyakayojo", "Mbarara Municipality", "Mbarara"], ["RWAKISHAKIZI II", "Rwakishakizi Ward", "Nyakayojo", "Mbarara Municipality", "Mbarara"]]],
  ['Mukono Seeta', {country_code:'ug', county:'Mukono', town:'Mukono', suburb:'Seeta', neighbourhood:'Njerere'},
    ["Mukono", "Mukono Municipality", "Goma Division", "Seeta Ward", "NJERERE"],
    [["BUSIMBE", "Seeta-Nazigo", "Nakisunga", "Mukono County South", "Mukono"], ["BUWAALI", "Seeta-Nazigo", "Nakisunga", "Mukono County South", "Mukono"], ["KAVULE", "Seeta-Nazigo", "Nakisunga", "Mukono County South", "Mukono"], ["KIRIJJA-BUTOOKE", "Seeta-Nazigo", "Nakisunga", "Mukono County South", "Mukono"], ["KIRONDO", "Seeta-Nazigo", "Nakisunga", "Mukono County South", "Mukono"], ["KIRWANYI", "Seeta-Nazigo", "Nakisunga", "Mukono County South", "Mukono"], ["KITEZA", "Seeta-Nazigo", "Nakisunga", "Mukono County South", "Mukono"], ["MAKATA", "Seeta-Nazigo", "Nakisunga", "Mukono County South", "Mukono"], ["NAMALIGA", "Seeta-Nazigo", "Nakisunga", "Mukono County South", "Mukono"], ["SEETA - NAZIGO", "Seeta-Nazigo", "Nakisunga", "Mukono County South", "Mukono"], ["BAGGALA", "Seeta Ward", "Goma Division", "Mukono Municipality", "Mukono"], ["BUGOBA", "Seeta Ward", "Goma Division", "Mukono Municipality", "Mukono"], ["GONGOBE", "Seeta Ward", "Goma Division", "Mukono Municipality", "Mukono"], ["GULAMA", "Seeta Ward", "Goma Division", "Mukono Municipality", "Mukono"], ["GWAFU CENTRAL", "Seeta Ward", "Goma Division", "Mukono Municipality", "Mukono"], ["GWAFU WEST", "Seeta Ward", "Goma Division", "Mukono Municipality", "Mukono"], ["KIROWOZA", "Seeta Ward", "Goma Division", "Mukono Municipality", "Mukono"], ["NABUTA", "Seeta Ward", "Goma Division", "Mukono Municipality", "Mukono"], ["NJERERE", "Seeta Ward", "Goma Division", "Mukono Municipality", "Mukono"], ["NTINDA", "Seeta Ward", "Goma Division", "Mukono Municipality", "Mukono"], ["NAKASEETA II", "Nagojje", "Nagojje", "Nakifuma County", "Mukono"], ["NAKASEETA I", "Namataba B Ward", "Namataba Town Council", "Nakifuma County", "Mukono"], ["SEETA", "Namanoga", "Namuganga", "Nakifuma County", "Mukono"]]],
  ['Sembabule (spelling)', {country_code:'ug', county:'Sembabule', town:'Mateete', village:'Kasana B'},
    ["Ssembabule", "Mawogola County", "Mateete Town Council", "Kasaana Ward", "KASAANA B"],
    [["KASAANA", "Lwensankala", "Lwemiyaga", "Lwemiyaga County", "Ssembabule"], ["KASANA", "Kayunga", "Mateete", "Mawogola County", "Ssembabule"], ["KABULASOKE", "Kasaana Ward", "Mateete Town Council", "Mawogola County", "Ssembabule"], ["KASAANA  A", "Kasaana Ward", "Mateete Town Council", "Mawogola County", "Ssembabule"], ["KASAANA  B", "Kasaana Ward", "Mateete Town Council", "Mawogola County", "Ssembabule"], ["KASAANA  C", "Kasaana Ward", "Mateete Town Council", "Mawogola County", "Ssembabule"], ["KASANA", "Kanoni", "Mijwala", "Mawogola North County", "Ssembabule"]]],
  ['Wakiso Busabala', {country_code:'ug', county:'Wakiso', city_district:'Masajja', suburb:'Busabala'},
    ["Wakiso", "Makindye-Ssabagabo Municipality", "Masajja Division", "BUSABALA WARD", "BUSABALA"],
    [["BUGGU", "BUSABALA WARD", "Masajja Division", "Makindye-Ssabagabo Municipality", "Wakiso"], ["BUSABALA", "BUSABALA WARD", "Masajja Division", "Makindye-Ssabagabo Municipality", "Wakiso"], ["GGANGU A", "BUSABALA WARD", "Masajja Division", "Makindye-Ssabagabo Municipality", "Wakiso"], ["GGANGU B", "BUSABALA WARD", "Masajja Division", "Makindye-Ssabagabo Municipality", "Wakiso"], ["GGANGU C", "BUSABALA WARD", "Masajja Division", "Makindye-Ssabagabo Municipality", "Wakiso"], ["KABUUMA", "BUSABALA WARD", "Masajja Division", "Makindye-Ssabagabo Municipality", "Wakiso"], ["KIBIRI A", "BUSABALA WARD", "Masajja Division", "Makindye-Ssabagabo Municipality", "Wakiso"], ["KIBIRI B", "BUSABALA WARD", "Masajja Division", "Makindye-Ssabagabo Municipality", "Wakiso"], ["KIRINDA", "BUSABALA WARD", "Masajja Division", "Makindye-Ssabagabo Municipality", "Wakiso"], ["ZIRANUMBU", "BUSABALA WARD", "Masajja Division", "Makindye-Ssabagabo Municipality", "Wakiso"], ["MASAJJA B", "MASAJJA WARD", "Masajja Division", "Makindye-Ssabagabo Municipality", "Wakiso"], ["MASAJJA-KIBIRA B", "MASAJJA WARD", "Masajja Division", "Makindye-Ssabagabo Municipality", "Wakiso"], ["NAMASUBA-KIKAJJO", "MASAJJA WARD", "Masajja Division", "Makindye-Ssabagabo Municipality", "Wakiso"], ["MASAJJA A", "NAMASUBA WARD", "Masajja Division", "Makindye-Ssabagabo Municipality", "Wakiso"], ["MASAJJA-KIBIRA A", "NAMASUBA WARD", "Masajja Division", "Makindye-Ssabagabo Municipality", "Wakiso"]]],
  ['Entebbe Nkumba', {country_code:'ug', amenity:'Nkumba Primary School', road:'Nkumba Road', village:'Bendegere A', city_district:'Kasenyi', city:'Entebbe City', state:'Central Region'},
    ["Wakiso", "Busiro County South", "Katabi Town Council", "NKUMBA WARD", "NKUMBA BENDEGERE"],
    [["ABAITA ABABIRI", "NKUMBA WARD", "Katabi Town Council", "Busiro County South", "Wakiso"], ["BUFULU", "NKUMBA WARD", "Katabi Town Council", "Busiro County South", "Wakiso"], ["KITINDA", "NKUMBA WARD", "Katabi Town Council", "Busiro County South", "Wakiso"], ["NKUMBA BENDEGERE", "NKUMBA WARD", "Katabi Town Council", "Busiro County South", "Wakiso"], ["NKUMBA BUKOLWA", "NKUMBA WARD", "Katabi Town Council", "Busiro County South", "Wakiso"], ["NKUMBA CENTRAL", "NKUMBA WARD", "Katabi Town Council", "Busiro County South", "Wakiso"]]],
];

describe('signage GPS official chain across Uganda', () => {
  it.each(CASES)('%s', (_label, osm, expected, rows) => {
    const loc = signageGpsLocation({ address: 'x', raw: { address: osm } });
    expect(loc).not.toBeNull();
    const districts = resolveDistricts(osm, D, C).map((x) => x.name);
    expect(districts).toEqual([expected[0]]);
    const villages = rows.map(([village, parish, subcounty, county, district]) => ({ village, parish, subcounty, county, district }));
    const m = mergeOfficialChain(loc!, osm, { districts, villages });
    expect([m.district, m.county, m.subcounty, m.parish, m.village]).toEqual(expected);
  });

  it('resolves districts from the spellings and labels geocoders use', () => {
    const r = (a: Record<string, string>) => resolveDistricts({ country_code: 'ug', ...a }, D, C).map((x) => x.name);
    expect(r({ county: 'Luwero' })).toEqual(['Luweero']);
    expect(r({ county: 'Sembabule' })).toEqual(['Ssembabule']);
    expect(r({ county: 'Kassanda' })).toEqual(['Kasanda']);
    expect(r({ county: 'Kampala Capital City' })).toEqual(['Kampala']);
    expect(r({ county: 'Madi Okollo District' })).toEqual(['Madi-Okollo']);
    expect(r({ city: 'Fort Portal Tourism City' })).toEqual(['Kabarole']);
    expect(r({ city: 'Kira' })).toEqual(['Wakiso']);
    // A district named directly wins over a county of the same name left over from a split.
    expect(r({ county: 'Kazo' })).toEqual(['Kazo']);
    expect(r({ county: 'Rwampara' })).toEqual(['Rwampara']);
    // Regions are never districts.
    expect(r({ state: 'Central Region' })).toEqual([]);
  });

  it('keeps cell numerals and letters distinct and drops landmark words', () => {
    expect(searchTokens({ amenity: 'Nkumba Primary School', road: 'Nkumba Road', city: 'Entebbe City' })).toEqual(['nkumba']);
    const loc = signageGpsLocation({ address: 'x', raw: { address: { country_code: 'ug', city: 'Mbarara City', village: 'Rwakishakizi I' } } })!;
    const ward = { parish: 'Rwakishakizi Ward', subcounty: 'Nyakayojo', county: 'Mbarara Municipality', district: 'Mbarara' };
    const m = mergeOfficialChain(loc, { city: 'Mbarara City', village: 'Rwakishakizi I' }, { districts: ['Mbarara'], villages: [
      { village: 'RWAKISHAKIZI I', ...ward }, { village: 'RWAKISHAKIZI II', ...ward },
    ] });
    expect(m.village).toBe('RWAKISHAKIZI I');
  });
});
