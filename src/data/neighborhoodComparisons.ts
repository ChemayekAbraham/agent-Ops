// Neighborhood comparison guides — /guides/compare/:comparisonSlug
// Data is editorial and refreshed with the CITY_GUIDES cadence.

export type ComparisonRow = {
  label: string;
  a: string;
  b: string;
};

export type NeighborhoodComparison = {
  slug: string; // e.g. 'ntinda-vs-bukoto'
  aName: string;
  bName: string;
  city: string;
  regionSlug: string; // for CTA back to /find-a-house/:regionSlug
  updatedOn: string;
  summary: string;
  rentTable: {
    tier: string;
    aRangeUgx: [number, number];
    bRangeUgx: [number, number];
  }[];
  rows: ComparisonRow[];
  verdict: string;
  bestFor: { a: string; b: string };
  faqs: { q: string; a: string }[];
};

const UPDATED = '2026-01-15';

export const NEIGHBORHOOD_COMPARISONS: NeighborhoodComparison[] = [
  {
    slug: 'ntinda-vs-bukoto',
    aName: 'Ntinda',
    bName: 'Bukoto',
    city: 'Kampala',
    regionSlug: 'kampala',
    updatedOn: UPDATED,
    summary:
      'Ntinda and Bukoto sit on the same north-eastern ridge of Kampala and are constantly compared by tenants moving up from studios to family-sized apartments. Ntinda wins on schools, malls and space; Bukoto wins on nightlife, cafes and proximity to the CBD.',
    rentTable: [
      { tier: 'Self-contained single', aRangeUgx: [300000, 550000], bRangeUgx: [400000, 700000] },
      { tier: '1-bedroom apartment', aRangeUgx: [600000, 1300000], bRangeUgx: [800000, 1600000] },
      { tier: '2-bedroom apartment', aRangeUgx: [1000000, 2200000], bRangeUgx: [1300000, 2800000] },
      { tier: '3-bedroom / townhouse', aRangeUgx: [1800000, 4500000], bRangeUgx: [2200000, 5500000] },
    ],
    rows: [
      { label: 'Vibe', a: 'Family suburb, quieter streets, walkable malls', b: 'Young professional, café culture, expat-heavy' },
      { label: 'Distance to CBD', a: '7 km (25–45 min in traffic)', b: '4 km (15–30 min in traffic)' },
      { label: 'Schools nearby', a: 'Kabira, Kampala Parents, Greenhill', b: 'Kampala Junior, Kabira International (border)' },
      { label: 'Shopping', a: 'Capital Shoppers, Ntinda Complex', b: 'Village Mall, Cooper Complex' },
      { label: 'Nightlife', a: 'Muted — mostly restaurants', b: 'Strong — Bukoto Street, Kisementi border' },
      { label: 'Traffic pain', a: 'Ntinda–Kisaasi road jams at rush', b: 'Bukoto–Kamwokya slow at rush, but shorter' },
      { label: 'Security', a: 'Good, established estates', b: 'Good, more foot traffic day and night' },
      { label: 'Water pressure', a: 'Consistent NWSC', b: 'Consistent NWSC' },
    ],
    verdict:
      'If you have kids or want more square metres per shilling, choose Ntinda. If you want to be a boda-boda ride from town and inside the café/gym belt, choose Bukoto and pay the ~15–25% premium.',
    bestFor: {
      a: 'Families, remote workers who want space, tenants moving from a smaller room.',
      b: 'Young professionals, expats, couples who value nightlife and walkability.',
    },
    faqs: [
      { q: 'Is Bukoto more expensive than Ntinda?', a: 'Yes. Equivalent apartments in Bukoto typically cost 15–25% more than Ntinda in 2026, mostly because of the shorter commute.' },
      { q: 'Which is safer, Ntinda or Bukoto?', a: 'Both are considered among the safer suburbs of Kampala. Ntinda feels quieter after 10pm; Bukoto has more people out later, which some tenants prefer.' },
    ],
  },
  {
    slug: 'kira-vs-najjera',
    aName: 'Kira',
    bName: 'Najjera',
    city: 'Wakiso / Kampala',
    regionSlug: 'kira',
    updatedOn: UPDATED,
    summary:
      'Kira and Najjera are the twin suburbs driving Kampala’s eastern growth. Both offer newer estates and self-contained apartments, but Kira leans slightly newer while Najjera leans slightly closer to the CBD.',
    rentTable: [
      { tier: 'Self-contained single', aRangeUgx: [250000, 450000], bRangeUgx: [280000, 500000] },
      { tier: '1-bedroom apartment', aRangeUgx: [400000, 900000], bRangeUgx: [450000, 1000000] },
      { tier: '2-bedroom apartment', aRangeUgx: [700000, 1600000], bRangeUgx: [800000, 1800000] },
      { tier: '3-bedroom / townhouse', aRangeUgx: [1200000, 3000000], bRangeUgx: [1400000, 3300000] },
    ],
    rows: [
      { label: 'Vibe', a: 'Newer estates, planned layouts', b: 'Denser, closer to Najjera–Kisaasi hub' },
      { label: 'Distance to CBD', a: '12 km (40–75 min)', b: '9 km (30–60 min)' },
      { label: 'Roads', a: 'Mostly murram inside estates', b: 'Mostly murram, some tarmac' },
      { label: 'Amenities', a: 'Kirinya Mall, growing supermarkets', b: 'Multiple small malls, banks, gyms' },
      { label: 'Security', a: 'Very good — estate-run', b: 'Good — mixed housing' },
      { label: 'Ideal tenant', a: 'Buyers-to-be, families wanting compound', b: 'Renters who want short commute + modernity' },
    ],
    verdict:
      'Kira gives you more compound and a newer feel for the same rent. Najjera gets you 15–25 minutes closer to town on most days. Pick by how much your time in traffic costs.',
    bestFor: {
      a: 'Buyers-in-waiting, families, tenants prioritising space.',
      b: 'Working commuters, couples, tenants who dislike long taxi queues.',
    },
    faqs: [
      { q: 'Is Kira cheaper than Najjera?', a: 'Slightly. Comparable units in Kira are typically 5–10% cheaper than Najjera, mainly because Najjera is a few kilometres closer to town.' },
    ],
  },
  {
    slug: 'muyenga-vs-bugolobi',
    aName: 'Muyenga',
    bName: 'Bugolobi',
    city: 'Kampala',
    regionSlug: 'kampala',
    updatedOn: UPDATED,
    summary:
      'Muyenga and Bugolobi are Kampala’s classic upmarket rivals. Muyenga sells the hilltop view; Bugolobi sells the flat, walkable grid closer to the industrial belt and airport road.',
    rentTable: [
      { tier: '1-bedroom apartment', aRangeUgx: [1000000, 2200000], bRangeUgx: [1100000, 2400000] },
      { tier: '2-bedroom apartment', aRangeUgx: [1600000, 3800000], bRangeUgx: [1800000, 4200000] },
      { tier: '3-bedroom apartment', aRangeUgx: [2500000, 6000000], bRangeUgx: [2800000, 6500000] },
      { tier: '4-bedroom townhouse', aRangeUgx: [4500000, 12000000], bRangeUgx: [5000000, 14000000] },
    ],
    rows: [
      { label: 'Signature feature', a: 'Hilltop views over Lake Victoria', b: 'Flat grid, walkable streets' },
      { label: 'Distance to CBD', a: '6 km (20–40 min)', b: '4 km (15–30 min)' },
      { label: 'To Entebbe airport', a: '35–55 min via southern bypass', b: '30–50 min via airport road' },
      { label: 'Cafes / restaurants', a: 'Muyenga Tank Hill Rd corridor', b: 'Village Mall Bugolobi, Café Javas' },
      { label: 'International schools', a: 'Kabojja Junior, Nakasero Prep (close)', b: 'Kampala Parents, GEMS (close)' },
    ],
    verdict:
      'For view and prestige, Muyenga. For walkability, café density and airport access, Bugolobi. Expect Bugolobi to run 5–10% more expensive at every tier.',
    bestFor: {
      a: 'View-driven expats, long-term families who plan to stay.',
      b: 'Working professionals, frequent travellers, walk-everywhere tenants.',
    },
    faqs: [
      { q: 'Which is more upmarket, Muyenga or Bugolobi?', a: 'Both are among Kampala’s top-tier suburbs. Bugolobi is denser and more walkable; Muyenga is hillier with lake views. Rent is broadly similar, with Bugolobi slightly higher.' },
    ],
  },
  {
    slug: 'bukoto-vs-kamwokya',
    aName: 'Bukoto',
    bName: 'Kamwokya',
    city: 'Kampala',
    regionSlug: 'kampala',
    updatedOn: UPDATED,
    summary:
      'Bukoto and Kamwokya are neighbours separated by a valley and a very different vibe. Bukoto is manicured and residential; Kamwokya is dense, entrepreneurial and much cheaper.',
    rentTable: [
      { tier: 'Single room / muzigo', aRangeUgx: [200000, 400000], bRangeUgx: [120000, 250000] },
      { tier: 'Self-contained single', aRangeUgx: [400000, 700000], bRangeUgx: [200000, 450000] },
      { tier: '1-bedroom apartment', aRangeUgx: [800000, 1600000], bRangeUgx: [400000, 900000] },
      { tier: '2-bedroom apartment', aRangeUgx: [1300000, 2800000], bRangeUgx: [700000, 1400000] },
    ],
    rows: [
      { label: 'Vibe', a: 'Manicured residential', b: 'Dense, mixed-use, lively' },
      { label: 'Distance to CBD', a: '4 km', b: '3 km' },
      { label: 'Rent premium', a: 'High', b: 'Low' },
      { label: 'Nightlife', a: 'Bukoto Street', b: 'Kisementi border, informal spots' },
      { label: 'Security posture', a: 'Estates + private guards', b: 'Higher foot traffic, be selective on plot' },
    ],
    verdict:
      'If your budget cracks UGX 800,000/month for a 1-bedroom, Bukoto gives you a calmer street. If you need the same walk to town for half the rent, Kamwokya is the answer — just choose your plot carefully.',
    bestFor: {
      a: 'Professionals who want a settled residential feel with easy CBD access.',
      b: 'Cost-conscious tenants who want to be in the middle of everything.',
    },
    faqs: [
      { q: 'Is Kamwokya cheaper than Bukoto?', a: 'Yes, materially. Comparable units in Kamwokya are commonly 40–55% cheaper than Bukoto, though the streets are denser and busier.' },
    ],
  },
  {
    slug: 'ntinda-vs-naalya',
    aName: 'Ntinda',
    bName: 'Naalya',
    city: 'Kampala',
    regionSlug: 'kampala',
    updatedOn: UPDATED,
    summary:
      'Ntinda and Naalya both attract families moving up-market. Ntinda is more established with better shopping; Naalya is newer with more modern estates and typically 10–20% cheaper rent.',
    rentTable: [
      { tier: 'Self-contained single', aRangeUgx: [300000, 550000], bRangeUgx: [250000, 500000] },
      { tier: '1-bedroom apartment', aRangeUgx: [600000, 1300000], bRangeUgx: [500000, 1100000] },
      { tier: '2-bedroom apartment', aRangeUgx: [1000000, 2200000], bRangeUgx: [800000, 1800000] },
      { tier: '3-bedroom / townhouse', aRangeUgx: [1800000, 4500000], bRangeUgx: [1500000, 3800000] },
    ],
    rows: [
      { label: 'Vibe', a: 'Established family suburb', b: 'Newer estates, planned' },
      { label: 'Distance to CBD', a: '7 km (25–45 min)', b: '10 km (35–60 min)' },
      { label: 'Shopping', a: 'Capital Shoppers, Ntinda Complex', b: 'Metroplex Naalya, Quality' },
      { label: 'Schools', a: 'Kabira, Kampala Parents', b: 'Kabojja Naalya, Vine' },
    ],
    verdict:
      'Naalya trades ~10 minutes of commute for ~15% rent savings and newer construction. If you need to be in Ntinda for school runs or work, the premium is worth it.',
    bestFor: {
      a: 'School-run families, tenants who want shorter Ntinda commute.',
      b: 'Cost-conscious families who prefer newer builds and don’t mind extra minutes.',
    },
    faqs: [
      { q: 'Is Naalya cheaper than Ntinda?', a: 'Yes. Naalya rents typically run 10–20% below Ntinda for equivalent apartments in 2026.' },
    ],
  },
  {
    slug: 'kansanga-vs-muyenga',
    aName: 'Kansanga',
    bName: 'Muyenga',
    city: 'Kampala',
    regionSlug: 'kampala',
    updatedOn: UPDATED,
    summary:
      'Kansanga and Muyenga share the same hill. Kansanga is the busy, student-heavy foot; Muyenga is the quiet, upmarket top. The two neighbourhoods can differ 3–5× in rent for the same square metres.',
    rentTable: [
      { tier: 'Single room / muzigo', aRangeUgx: [150000, 350000], bRangeUgx: [300000, 650000] },
      { tier: 'Self-contained single', aRangeUgx: [250000, 500000], bRangeUgx: [500000, 1000000] },
      { tier: '1-bedroom apartment', aRangeUgx: [400000, 900000], bRangeUgx: [1000000, 2200000] },
      { tier: '2-bedroom apartment', aRangeUgx: [700000, 1500000], bRangeUgx: [1600000, 3800000] },
    ],
    rows: [
      { label: 'Vibe', a: 'Student-heavy, buzzing, cheap food', b: 'Quiet, upmarket, hilltop views' },
      { label: 'Distance to CBD', a: '6 km', b: '6 km' },
      { label: 'Nightlife', a: 'Very strong — Ggaba Road corridor', b: 'Restaurants only, quiet after 11pm' },
      { label: 'Ideal tenant', a: 'Students, first-job graduates', b: 'Executives, expats, established families' },
    ],
    verdict:
      'Same hill, very different budgets. Kansanga gives you Kampala’s liveliest student-affordable belt; Muyenga gives you the postcode and the view.',
    bestFor: {
      a: 'Students, early-career tenants, cost-first movers.',
      b: 'Senior professionals, families with school-going kids, view-lovers.',
    },
    faqs: [
      { q: 'Why is Muyenga so much more expensive than Kansanga?', a: 'Both share the same hill, but Muyenga is at the top with lower density, private estates and lake views — features that command 2–3× the rent of equivalent-sized units in Kansanga.' },
    ],
  },
];

export function getComparison(slug: string): NeighborhoodComparison | undefined {
  return NEIGHBORHOOD_COMPARISONS.find((c) => c.slug === slug.toLowerCase());
}

export const COMPARISON_SLUGS = NEIGHBORHOOD_COMPARISONS.map((c) => c.slug);
