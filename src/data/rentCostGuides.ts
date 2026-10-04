// Editorial rent-cost data used by /guides/cost-of-renting-in-:citySlug.
// Figures are market-typical ranges gathered from Welile listings and public
// broker averages; they are presented as guidance, not quotations. Update the
// `updatedOn` field whenever the ranges are refreshed.

export type RentTier = {
  label: string;
  rangeUgx: [number, number];
  notes?: string;
};

export type PopularArea = {
  name: string;
  vibe: string;
  typicalMonthlyUgx: [number, number];
  regionSlug?: string;
};

export type CityGuide = {
  slug: string;
  city: string;
  region: string;
  regionSlug: string;
  tagline: string;
  intro: string;
  updatedOn: string;
  tiers: RentTier[];
  popularAreas: PopularArea[];
  utilityNote: string;
  commuteNote: string;
  savingsTip: string;
  faqs: { q: string; a: string }[];
};

const UPDATED = '2026-01-15';

export const CITY_GUIDES: CityGuide[] = [
  {
    slug: 'kampala',
    city: 'Kampala',
    region: 'Central Region',
    regionSlug: 'kampala',
    tagline: 'Uganda’s capital — the widest range of rent in the country.',
    intro:
      'Rent in Kampala varies enormously by neighbourhood. A single room in a suburb like Kawempe or Bwaise can cost less than UGX 200,000/month, while a two-bedroom apartment in Kololo, Nakasero or Bugolobi can cross UGX 3,000,000/month. This guide breaks down what most tenants actually pay in 2026, area by area, and how to split it into weekly instalments with Welile.',
    updatedOn: UPDATED,
    tiers: [
      { label: 'Single room / muzigo', rangeUgx: [120000, 350000], notes: 'Shared compound, shared bathroom in most suburbs.' },
      { label: 'Self-contained single', rangeUgx: [250000, 600000], notes: 'Own bathroom, tiled floor, common in Ntinda, Kyanja, Namugongo.' },
      { label: '1-bedroom apartment', rangeUgx: [500000, 1500000], notes: 'Naalya, Bukoto, Kansanga entry range.' },
      { label: '2-bedroom apartment', rangeUgx: [900000, 3500000], notes: 'Bukoto, Ntinda, Muyenga typical; Kololo well above.' },
      { label: '3-bedroom / townhouse', rangeUgx: [1800000, 8000000], notes: 'Munyonyo, Bugolobi, Kololo, Naguru upper end.' },
    ],
    popularAreas: [
      { name: 'Ntinda', vibe: 'Family suburb, good schools, walk-to-mall', typicalMonthlyUgx: [700000, 2200000], regionSlug: 'kampala' },
      { name: 'Bukoto', vibe: 'Young professionals, cafes, close to town', typicalMonthlyUgx: [900000, 2800000], regionSlug: 'kampala' },
      { name: 'Naalya', vibe: 'Modern estates, quieter, growing fast', typicalMonthlyUgx: [600000, 1800000], regionSlug: 'kampala' },
      { name: 'Kansanga', vibe: 'Student area, buzzing, affordable self-contained', typicalMonthlyUgx: [300000, 900000], regionSlug: 'kampala' },
      { name: 'Muyenga', vibe: 'Hilltop views, established, upmarket', typicalMonthlyUgx: [1200000, 4000000], regionSlug: 'kampala' },
      { name: 'Kyanja', vibe: 'Newer developments, self-contained singles', typicalMonthlyUgx: [350000, 1200000], regionSlug: 'kampala' },
    ],
    utilityNote:
      'Water and Umeme electricity are usually paid separately. Budget UGX 40,000–120,000/month for a single occupant, more for a family. Yaka tokens are pay-as-you-go.',
    commuteNote:
      'Boda-boda into the CBD from Ntinda or Bukoto typically costs UGX 3,000–6,000 one way. Taxi (matatu) is UGX 1,500–2,500. Traffic peaks 7–9am and 5–7pm.',
    savingsTip:
      'Landlords in Kampala often ask for 3 months upfront plus a deposit. With Welile you can move in by paying just the first weekly instalment; we settle the landlord in full so you keep your savings.',
    faqs: [
      { q: 'How much is rent in Kampala per month in 2026?', a: 'Most Kampala tenants pay between UGX 250,000 for a self-contained single room and UGX 2,500,000 for a 2-bedroom apartment. Kololo, Nakasero and parts of Muyenga sit above that range.' },
      { q: 'Which is the cheapest area to rent in Kampala?', a: 'Kawempe, Bwaise, Kisenyi, Ndeeba and parts of Nateete offer the lowest rent in Kampala — often under UGX 200,000 for a single room — though amenities and security vary.' },
      { q: 'Can I pay Kampala rent in weekly instalments?', a: 'Yes. Welile pays your landlord the full monthly or quarterly rent, and you repay in weekly or daily instalments sized to your income.' },
    ],
  },
  {
    slug: 'wakiso',
    city: 'Wakiso',
    region: 'Central Region',
    regionSlug: 'wakiso',
    tagline: 'Kampala’s commuter belt — more space for the same money.',
    intro:
      'Wakiso wraps around Kampala and includes fast-growing towns like Kira, Nansana, Bweyogerere and Matugga. Rent is typically 30–50% cheaper than equivalent Kampala neighbourhoods, at the cost of a longer commute.',
    updatedOn: UPDATED,
    tiers: [
      { label: 'Single room / muzigo', rangeUgx: [80000, 220000] },
      { label: 'Self-contained single', rangeUgx: [180000, 450000] },
      { label: '1-bedroom apartment', rangeUgx: [300000, 800000] },
      { label: '2-bedroom apartment', rangeUgx: [500000, 1500000] },
      { label: '3-bedroom / townhouse', rangeUgx: [900000, 3000000] },
    ],
    popularAreas: [
      { name: 'Kira', vibe: 'Fastest-growing suburb, modern estates', typicalMonthlyUgx: [400000, 1400000], regionSlug: 'kira' },
      { name: 'Nansana', vibe: 'Dense, affordable, well-served by taxis', typicalMonthlyUgx: [180000, 700000], regionSlug: 'nansana' },
      { name: 'Bweyogerere', vibe: 'Northern-bypass access, industrial-adjacent', typicalMonthlyUgx: [250000, 900000], regionSlug: 'bweyogerere' },
      { name: 'Matugga', vibe: 'Cheaper, further out, land available', typicalMonthlyUgx: [150000, 500000] },
    ],
    utilityNote: 'Umeme electricity is universal; NWSC piped water reaches most trading centres but some plots still use boreholes. Budget UGX 30,000–90,000/month for utilities.',
    commuteNote: 'Commute into Kampala CBD is 45–90 minutes in traffic. Taxi fares are UGX 2,000–4,000 one way; boda-boda UGX 8,000–15,000.',
    savingsTip: 'Wakiso landlords are often flexible on move-in date but strict on the upfront lump sum. Welile settles them in full so you can start with just your first instalment.',
    faqs: [
      { q: 'Is Wakiso cheaper than Kampala?', a: 'Yes. Comparable houses in Wakiso are typically 30–50% cheaper than Kampala, but tenants add a daily commute cost of UGX 3,000–8,000 in taxi or boda fares.' },
      { q: 'What is the average rent in Kira?', a: 'A self-contained single in Kira runs UGX 250,000–450,000/month, and a 2-bedroom apartment UGX 700,000–1,400,000/month in 2026.' },
    ],
  },
  {
    slug: 'entebbe',
    city: 'Entebbe',
    region: 'Wakiso District',
    regionSlug: 'entebbe',
    tagline: 'Lakeside town, airport suburb, premium at the water’s edge.',
    intro: 'Entebbe combines a small-town feel with international demand from airline crews, NGOs and lake-view buyers. Rent near the lake and along Airport Road is priced closer to upmarket Kampala.',
    updatedOn: UPDATED,
    tiers: [
      { label: 'Single room / muzigo', rangeUgx: [120000, 280000] },
      { label: 'Self-contained single', rangeUgx: [250000, 500000] },
      { label: '1-bedroom apartment', rangeUgx: [500000, 1200000] },
      { label: '2-bedroom apartment', rangeUgx: [900000, 2500000] },
      { label: '3-bedroom / lake view', rangeUgx: [1800000, 6000000] },
    ],
    popularAreas: [
      { name: 'Kitoro', vibe: 'Local, walkable, close to town centre', typicalMonthlyUgx: [200000, 700000] },
      { name: 'Kitala', vibe: 'Quieter, mixed housing, closer to airport', typicalMonthlyUgx: [300000, 1100000] },
      { name: 'Lake Victoria View', vibe: 'Premium lakeside estates', typicalMonthlyUgx: [1500000, 5000000] },
    ],
    utilityNote: 'Utilities similar to Kampala. Piped water is reliable; expect UGX 40,000–100,000/month per single household.',
    commuteNote: 'Entebbe Expressway shortens the Kampala trip to about 35–50 minutes. Public taxi to Kampala Old Park costs UGX 5,000–7,000.',
    savingsTip: 'Airport-area landlords often list rent in USD but accept UGX at the day’s rate. Welile pays in UGX and locks the exchange for you.',
    faqs: [
      { q: 'How much does it cost to rent near Entebbe Airport?', a: 'A self-contained single near the airport costs UGX 300,000–500,000/month. Full 2-bedroom apartments run UGX 1,000,000–2,500,000/month depending on lake proximity.' },
    ],
  },
  {
    slug: 'jinja',
    city: 'Jinja',
    region: 'Eastern Region',
    regionSlug: 'jinja',
    tagline: 'The source of the Nile — relaxed, colonial-era, growing tourism.',
    intro: 'Jinja rent is materially lower than Kampala but rising with tourism and the Bujagali corridor. Expect quiet streets, larger compounds and quicker landlord response times.',
    updatedOn: UPDATED,
    tiers: [
      { label: 'Single room / muzigo', rangeUgx: [70000, 180000] },
      { label: 'Self-contained single', rangeUgx: [150000, 350000] },
      { label: '1-bedroom apartment', rangeUgx: [250000, 700000] },
      { label: '2-bedroom apartment', rangeUgx: [450000, 1400000] },
      { label: '3-bedroom / standalone', rangeUgx: [800000, 2500000] },
    ],
    popularAreas: [
      { name: 'Main Street area', vibe: 'Central, walkable, cafes and tour operators', typicalMonthlyUgx: [300000, 1200000] },
      { name: 'Walukuba', vibe: 'Residential, closer to industrial area', typicalMonthlyUgx: [150000, 500000] },
      { name: 'Bugembe', vibe: 'Growing outskirts, cheaper land', typicalMonthlyUgx: [120000, 400000] },
    ],
    utilityNote: 'Umeme and NWSC coverage is good. Utility spend for a small household lands around UGX 40,000–80,000/month.',
    commuteNote: 'Boda-boda across town is UGX 2,000–4,000. Bus/taxi to Kampala is roughly 2 hours and UGX 15,000–25,000 one way.',
    savingsTip: 'Jinja landlords sometimes discount for 6-month upfront payments. Instead of draining savings, let Welile cover the 6 months and repay weekly.',
    faqs: [
      { q: 'What is the average rent in Jinja town in 2026?', a: 'A self-contained single in Jinja town costs UGX 180,000–350,000/month and a 2-bedroom apartment UGX 500,000–1,200,000/month in 2026.' },
    ],
  },
  {
    slug: 'mbarara',
    city: 'Mbarara',
    region: 'Western Region',
    regionSlug: 'mbarara',
    tagline: 'The capital of Ankole — fast-growing regional hub.',
    intro: 'Mbarara is the largest city in western Uganda and one of the fastest-growing urban markets outside Kampala. Rent has climbed with university enrolments and the Kampala–Kigali corridor.',
    updatedOn: UPDATED,
    tiers: [
      { label: 'Single room / muzigo', rangeUgx: [80000, 200000] },
      { label: 'Self-contained single', rangeUgx: [170000, 400000] },
      { label: '1-bedroom apartment', rangeUgx: [300000, 800000] },
      { label: '2-bedroom apartment', rangeUgx: [500000, 1500000] },
      { label: '3-bedroom / standalone', rangeUgx: [900000, 2500000] },
    ],
    popularAreas: [
      { name: 'Kakoba', vibe: 'Central, close to university and shops', typicalMonthlyUgx: [200000, 900000] },
      { name: 'Nyamitanga', vibe: 'Established, mixed residential', typicalMonthlyUgx: [180000, 700000] },
      { name: 'Kamukuzi', vibe: 'Government offices, quieter streets', typicalMonthlyUgx: [300000, 1100000] },
    ],
    utilityNote: 'Utilities are cheaper than Kampala; UGX 30,000–70,000/month covers a small household.',
    commuteNote: 'Most of Mbarara is walkable or a UGX 2,000–3,000 boda-boda hop. Kampala is a 4-hour bus ride at UGX 30,000–50,000.',
    savingsTip: 'Ask about landlord flexibility before you sign — many Mbarara landlords accept Welile-backed weekly rent once they see we settle in full.',
    faqs: [
      { q: 'Is Mbarara cheaper than Kampala for rent?', a: 'Yes. Mbarara rents run roughly 40–60% below equivalent Kampala neighbourhoods, though top-end 3-bedroom houses near Kamukuzi are catching up.' },
    ],
  },
  {
    slug: 'gulu',
    city: 'Gulu',
    region: 'Northern Region',
    regionSlug: 'gulu',
    tagline: 'Northern Uganda’s biggest city — affordable and expanding.',
    intro: 'Gulu remains one of the most affordable urban rental markets in Uganda, though NGOs and the Juba trade corridor have pushed prices in central plots upward.',
    updatedOn: UPDATED,
    tiers: [
      { label: 'Single room / muzigo', rangeUgx: [60000, 150000] },
      { label: 'Self-contained single', rangeUgx: [130000, 300000] },
      { label: '1-bedroom apartment', rangeUgx: [220000, 600000] },
      { label: '2-bedroom apartment', rangeUgx: [400000, 1200000] },
      { label: '3-bedroom / standalone', rangeUgx: [700000, 2000000] },
    ],
    popularAreas: [
      { name: 'Senior Quarters', vibe: 'Established, government housing legacy', typicalMonthlyUgx: [300000, 1100000] },
      { name: 'Layibi', vibe: 'Residential, close to schools', typicalMonthlyUgx: [180000, 600000] },
      { name: 'Kasubi', vibe: 'Newer plots, cheaper self-contained', typicalMonthlyUgx: [150000, 500000] },
    ],
    utilityNote: 'Utility bills are the lowest of any major Ugandan city, typically UGX 25,000–60,000/month for a small household.',
    commuteNote: 'Boda-boda hops across town are UGX 2,000–3,000. Bus to Kampala takes 5–6 hours at UGX 40,000–60,000.',
    savingsTip: 'Many Gulu landlords still ask for 6–12 months upfront. Welile turns that into weekly repayments so you can conserve working capital.',
    faqs: [
      { q: 'What is the cheapest area to rent in Gulu?', a: 'Kasubi, Layibi Techo and parts of Pece offer single rooms from UGX 60,000–120,000/month in 2026.' },
    ],
  },
  {
    slug: 'mukono',
    city: 'Mukono',
    region: 'Central Region',
    regionSlug: 'mukono',
    tagline: 'Eastern gateway — university town on the Jinja highway.',
    intro: 'Mukono is 21 km east of Kampala and hosts UCU. Rent is a middle ground between Kampala and Jinja, with strong student and staff demand.',
    updatedOn: UPDATED,
    tiers: [
      { label: 'Single room / muzigo', rangeUgx: [80000, 200000] },
      { label: 'Self-contained single', rangeUgx: [180000, 400000] },
      { label: '1-bedroom apartment', rangeUgx: [300000, 800000] },
      { label: '2-bedroom apartment', rangeUgx: [500000, 1400000] },
      { label: '3-bedroom / standalone', rangeUgx: [800000, 2500000] },
    ],
    popularAreas: [
      { name: 'Seeta', vibe: 'Fast-growing suburb, closer to Kampala', typicalMonthlyUgx: [250000, 1000000] },
      { name: 'Nsuube', vibe: 'Near UCU, student-heavy', typicalMonthlyUgx: [180000, 600000] },
      { name: 'Namumira', vibe: 'Quieter, larger compounds', typicalMonthlyUgx: [200000, 800000] },
    ],
    utilityNote: 'Utility spend is close to Kampala levels — UGX 35,000–80,000/month for a single household.',
    commuteNote: 'Taxis to Kampala Old Park cost UGX 3,000–5,000 and take 45–90 minutes depending on traffic.',
    savingsTip: 'Student-cycle rent (Aug–May) means January vacancies. Welile lets you lock in a January move-in without a lump sum.',
    faqs: [
      { q: 'How much is rent near UCU Mukono?', a: 'Self-contained single rooms near Nsuube and the UCU perimeter cost UGX 200,000–350,000/month in 2026.' },
    ],
  },
  {
    slug: 'nansana',
    city: 'Nansana',
    region: 'Wakiso District',
    regionSlug: 'nansana',
    tagline: 'One of Uganda’s most densely populated municipalities — rent that fits real wages.',
    intro: 'Nansana is a low-cost, high-density municipality just north-west of Kampala. It offers the shortest commute-to-price ratio in the greater Kampala area.',
    updatedOn: UPDATED,
    tiers: [
      { label: 'Single room / muzigo', rangeUgx: [70000, 180000] },
      { label: 'Self-contained single', rangeUgx: [150000, 350000] },
      { label: '1-bedroom apartment', rangeUgx: [250000, 650000] },
      { label: '2-bedroom apartment', rangeUgx: [450000, 1100000] },
      { label: '3-bedroom / standalone', rangeUgx: [700000, 1800000] },
    ],
    popularAreas: [
      { name: 'Nabweru', vibe: 'Residential, mixed housing', typicalMonthlyUgx: [180000, 700000] },
      { name: 'Gombe', vibe: 'Denser, cheapest single rooms', typicalMonthlyUgx: [80000, 300000] },
      { name: 'Wamala', vibe: 'Growing self-contained supply', typicalMonthlyUgx: [200000, 800000] },
    ],
    utilityNote: 'Utility costs mirror greater Kampala — UGX 30,000–80,000/month for a small household.',
    commuteNote: 'Taxis to Bwaise or CBD run UGX 2,000–3,500 and take 30–60 minutes depending on the northern-bypass traffic.',
    savingsTip: 'Landlords here often prefer upfront quarterly rent. Let Welile pay it in one shot and repay weekly — you keep your emergency fund.',
    faqs: [
      { q: 'What is rent like in Nansana?', a: 'Single rooms in Nansana start from UGX 80,000/month, and self-contained singles are commonly UGX 180,000–300,000/month in 2026.' },
    ],
  },
];

export function getCityGuide(slug: string): CityGuide | undefined {
  return CITY_GUIDES.find((g) => g.slug === slug.toLowerCase());
}

export const CITY_GUIDE_SLUGS = CITY_GUIDES.map((g) => g.slug);
