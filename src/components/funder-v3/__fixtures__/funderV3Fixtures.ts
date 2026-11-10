/**
 * Fixtures for the funder V3 parity test and the dev-only Playwright harness.
 * Shapes mirror what the live read services return; amounts cover the rent
 * tiers and a missing-amount case. Photos are inline 16:10 SVGs (no network).
 */
import type { FeedEntry, FunderListingsViewApi } from '@/components/supporter/FunderHouseListingsSection';
import type { FunderNewEmptyHouse, FunderNewFilters, FunderNewMarketSummary, FunderNewReadyPlan } from '@/components/funder-new/types';
import type { FunderNewLocationController } from '@/components/funder-new/useFunderNewLocation';
import { itemCoordinates } from '@/components/funder-new/utils';
import { straightLineDistance } from '@/components/funder-new/distance';

const HUES = [262, 152, 28, 208, 340, 48];

export function photo(index: number): string {
  const hue = HUES[index % HUES.length];
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="400" viewBox="0 0 640 400"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hue} 60% 78%)"/><stop offset="1" stop-color="hsl(${hue} 45% 52%)"/></linearGradient></defs><rect width="640" height="400" fill="url(#g)"/><path d="M220 260v-80l100-70 100 70v80z" fill="hsl(${hue} 40% 96%)" opacity=".85"/><rect x="295" y="205" width="50" height="55" fill="hsl(${hue} 40% 40%)" opacity=".6"/></svg>`;
  return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`;
}

const CATEGORIES = ['single_room', 'double_room', 'self_contained', 'two_bedroom', 'one_bedroom'];
const DISTRICTS = ['kampala', 'wakiso', 'mukono', 'entebbe'];
const VILLAGES = ['kansanga', 'ntinda', 'kira', 'najjera', 'bweyogerere', 'muyenga'];
/** Covers < 300k, 300k–800k, 800k–2M, ≥ 2M and a missing amount (index 7). */
const RENTS = [180000, 250000, 450000, 650000, 950000, 1500000, 2400000, 0];

export function makeEmptyHouse(index: number): FunderNewEmptyHouse {
  return {
    house_id: `house-${index}`,
    house_category: CATEGORIES[index % CATEGORIES.length],
    title: null,
    district: DISTRICTS[index % DISTRICTS.length],
    village: VILLAGES[index % VILLAGES.length],
    sub_county: null,
    region: 'central',
    monthly_rent: RENTS[index % RENTS.length],
    partner_monthly_return: index % 5 === 0 ? 99000 : null,
    image_urls: index % 6 === 5 ? [] : [photo(index)],
    image_url: null,
    latitude: 0.30 + (index % 9) * 0.012,
    longitude: 32.55 + (index % 7) * 0.014,
    verified: false,
  } as unknown as FunderNewEmptyHouse;
}

export function makeReadyPlan(index: number): FunderNewReadyPlan {
  return {
    rent_request_id: `plan-${index}`,
    house_category: CATEGORIES[(index + 2) % CATEGORIES.length],
    request_city: 'Kira Town Council',
    tenant_location: `${VILLAGES[(index + 1) % VILLAGES.length]}, Kira Town Council, Wakiso`,
    funding_amount: [320000, 540000, 1200000][index % 3],
    house_image_urls: [photo(index + 3)],
    request_latitude: 0.36 + (index % 4) * 0.01,
    request_longitude: 32.6 + (index % 3) * 0.01,
    duration_days: 90,
  } as unknown as FunderNewReadyPlan;
}

/** Rent Plans first, then empty houses — the live feed order. */
export function makeFeed(count: number, readyCount = Math.min(2, count)): FeedEntry[] {
  const ready = Array.from({ length: Math.min(readyCount, count) }, (_, i): FeedEntry => ({ category: 'ready', item: makeReadyPlan(i) }));
  const empty = Array.from({ length: Math.max(0, count - ready.length) }, (_, i): FeedEntry => ({ category: 'empty', item: makeEmptyHouse(i) }));
  return [...ready, ...empty];
}

export const FIXTURE_SUMMARY: FunderNewMarketSummary = {
  houseCount: 2534,
  totalRentNeeded: 1234567890,
  avgMonthlyRent: 487200,
  districts: [
    { value: 'kampala', label: 'Kampala', count: 1200 },
    { value: 'wakiso', label: 'Wakiso', count: 900 },
  ],
};

export const FIXTURE_DEVICE = { lat: 0.3136, lng: 32.5811 };

export function fixtureLocation(permission: FunderNewLocationController['permission'] = 'prompt', withCoords = false): FunderNewLocationController {
  return {
    permission,
    status: withCoords ? 'ready' : 'idle',
    coords: withCoords ? { ...FIXTURE_DEVICE, accuracyM: 20, at: Date.now() } : null,
    error: null,
    autoLocating: false,
    request: () => {},
    refresh: () => {},
    dismissError: () => {},
  };
}

export const DEFAULT_FILTERS: FunderNewFilters = {
  search: '',
  location: '',
  amount: 'all',
  sort: 'recommended',
  rentMin: null,
  rentMax: null,
  radiusKm: 'all',
  withinFloat: false,
};

/** A static listing API over fixture data (the shape the live section hands a view). */
export function fixtureApi(overrides: Partial<FunderListingsViewApi> = {}): FunderListingsViewApi {
  const items = overrides.items ?? makeFeed(12);
  const filteredTotal = overrides.filteredTotal ?? 2534;
  const location = overrides.location ?? fixtureLocation('granted', true);
  const device = location.coords ? { lat: location.coords.lat, lng: location.coords.lng } : null;
  const readyCount = items.filter((entry) => entry.category === 'ready').length;
  return {
    boardTagsOn: false,
    boardTagOf: () => null,
    readyTotal: readyCount,
    emptyTotal: Math.max(0, filteredTotal - readyCount),
    clearRadius: () => {},
    boardGroups: null,
    boardCounts: null,
    boardPins: [],
    boardLoading: false,
    boardError: false,
    searchInput: '',
    setSearchInput: () => {},
    filters: DEFAULT_FILTERS,
    activeFilterCount: 0,
    openFilters: () => {},
    effectiveSort: 'recommended',
    origin: null,
    changeSort: () => {},
    items,
    filteredTotal,
    remaining: Math.max(0, filteredTotal - items.length),
    feedLoading: false,
    feedError: false,
    feedFetching: false,
    feedFetchingNext: false,
    feedHasNext: items.length < filteredTotal,
    refetchFeed: () => {},
    fetchNextFeed: () => {},
    withinFloatApplied: false,
    isSaved: () => false,
    isSelected: () => false,
    distanceFor: (entry) => {
      const coords = itemCoordinates(entry.item, entry.category);
      return coords ? straightLineDistance(device, coords) : null;
    },
    toggleSave: () => {},
    toggleSelect: () => {},
    openDetail: () => {},
    location,
    ...overrides,
  };
}
