import type {
  AmountBucket,
  FunderNewCategory,
  FunderNewEmptyHouse,
  FunderNewFilters,
  FunderNewReadyPlan,
  FunderNewSelectionItem,
  FunderNewSort,
} from './types';
import { formatHouseCategory, prettyName } from '@/lib/formatting';
import { formatDynamicCompact, getDynamicCurrencySymbol } from '@/lib/currencyFormat';
import { readCoordinate } from './distance';

const MONTHLY_RETURN_RATE = 0.15;

export const FUNDER_NEW_RETURN_RATE = MONTHLY_RETURN_RATE;

export function toNumber(value: unknown): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

export function amountRange(bucket: AmountBucket): { min: number | null; max: number | null } {
  if (bucket === 'under_300k') return { min: null, max: 300000 };
  if (bucket === '300k_600k') return { min: 300000, max: 600000 };
  if (bucket === 'over_600k') return { min: 600000, max: null };
  return { min: null, max: null };
}

export function categoryLabel(category: FunderNewCategory) {
  return category === 'empty' ? 'Empty homes' : 'Tenant ready';
}

export function sortLabel(sort: FunderNewSort): string {
  if (sort === 'nearest') return 'Nearest first';
  if (sort === 'rent_low') return 'Lowest amount';
  if (sort === 'rent_high') return 'Highest amount';
  if (sort === 'newest') return 'Newest first';
  return 'Recommended';
}

/**
 * Splits a compact market total so the hero can render a smaller currency
 * prefix ahead of a dominant figure, e.g. { prefix: 'UGX', figure: '5.8B' }.
 */
export function compactParts(amount: number): { prefix: string; figure: string } {
  const compact = formatDynamicCompact(amount);
  const symbol = getDynamicCurrencySymbol();
  const figure = compact.startsWith(symbol) ? compact.slice(symbol.length).trim() : compact.replace(/^[^\d.,-]+/, '');
  return { prefix: symbol, figure: figure || compact };
}

export function emptyHouseTitle(house: FunderNewEmptyHouse): string {
  return house.title?.trim() || formatHouseCategory(house.house_category) || 'Empty house';
}

/**
 * Specific place line: village/neighbourhood first, district second.
 * Deliberately short so the listing does not repeat a long address.
 */
export function emptyHousePlace(house: FunderNewEmptyHouse): string {
  const local = [house.village, house.sub_county].map((part) => (part ? prettyName(part) : '')).filter(Boolean)[0];
  const district = house.district ? prettyName(house.district) : '';
  const parts = [local, district].filter(Boolean);
  if (parts.length) return parts.join(', ');
  return house.region ? prettyName(house.region) : 'Location on file';
}

export function readyPlanTitle(plan: FunderNewReadyPlan): string {
  return formatHouseCategory(plan.house_category) || 'Rent Plan';
}

export function readyPlanPlace(plan: FunderNewReadyPlan): string {
  const local = plan.tenant_location ? prettyName(plan.tenant_location) : '';
  const city = plan.request_city ? prettyName(plan.request_city) : '';
  const parts = [local, city].filter(Boolean).filter((part, index, all) => all.indexOf(part) === index);
  return parts.join(', ') || 'Location on file';
}

export function readyPlanTerm(plan: FunderNewReadyPlan): string {
  if (plan.duration_days && plan.duration_days > 0) {
    const months = Math.max(1, Math.round(plan.duration_days / 30));
    return `${months} ${months === 1 ? 'month' : 'months'}`;
  }
  return plan.repayment_cadence ? prettyName(plan.repayment_cadence) : 'Term on file';
}

export function itemId(category: FunderNewCategory, item: FunderNewEmptyHouse | FunderNewReadyPlan): string {
  return category === 'empty'
    ? (item as FunderNewEmptyHouse).house_id
    : (item as FunderNewReadyPlan).rent_request_id;
}

export function itemAmount(category: FunderNewCategory, item: FunderNewEmptyHouse | FunderNewReadyPlan): number {
  return category === 'empty'
    ? toNumber((item as FunderNewEmptyHouse).monthly_rent)
    : toNumber((item as FunderNewReadyPlan).funding_amount);
}

/**
 * Projected monthly Returns at the existing 15% rate.
 * Returns null when the underlying amount is unavailable — a real zero and
 * missing data are not the same thing.
 */
export function itemMonthlyReturn(
  category: FunderNewCategory,
  item: FunderNewEmptyHouse | FunderNewReadyPlan,
): number | null {
  if (category === 'empty') {
    const house = item as FunderNewEmptyHouse;
    const provided = toNumber(house.partner_monthly_return);
    if (provided > 0) return provided;
    const rent = toNumber(house.monthly_rent);
    return rent > 0 ? Math.round(rent * MONTHLY_RETURN_RATE) : null;
  }
  const amount = toNumber((item as FunderNewReadyPlan).funding_amount);
  return amount > 0 ? Math.round(amount * MONTHLY_RETURN_RATE) : null;
}

export function firstPhoto(category: FunderNewCategory, item: FunderNewEmptyHouse | FunderNewReadyPlan): string | null {
  if (category === 'empty') {
    const house = item as FunderNewEmptyHouse;
    return (house.image_urls ?? []).filter(Boolean)[0] || house.image_url || null;
  }
  return ((item as FunderNewReadyPlan).house_image_urls ?? []).filter(Boolean)[0] || null;
}

/**
 * House verification only. A ready tenant, a GPS pin, a paid status or the mere
 * existence of the listing are NOT house verification.
 */
export function isHouseVerified(category: FunderNewCategory, item: FunderNewEmptyHouse | FunderNewReadyPlan): boolean {
  if (category !== 'empty') return false;
  return (item as FunderNewEmptyHouse).verified === true;
}

export function toSelectionItem(
  category: FunderNewCategory,
  item: FunderNewEmptyHouse | FunderNewReadyPlan,
): FunderNewSelectionItem {
  return {
    id: itemId(category, item),
    category,
    title:
      category === 'empty' ? emptyHouseTitle(item as FunderNewEmptyHouse) : readyPlanTitle(item as FunderNewReadyPlan),
    place:
      category === 'empty' ? emptyHousePlace(item as FunderNewEmptyHouse) : readyPlanPlace(item as FunderNewReadyPlan),
    amount: itemAmount(category, item),
    monthlyReturn: itemMonthlyReturn(category, item),
    termLabel: category === 'empty' ? '1 month house support' : readyPlanTerm(item as FunderNewReadyPlan),
    imageUrl: firstPhoto(category, item),
  };
}

export function matchesReadyPlanSearch(plan: FunderNewReadyPlan, filters: FunderNewFilters): boolean {
  const q = filters.search.trim().toLowerCase();
  if (!q) return true;
  const haystack = [
    readyPlanTitle(plan),
    readyPlanPlace(plan),
    plan.house_category,
    plan.landlord_name,
    plan.tenant_first_name,
    plan.tenant_full_name,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  return haystack.includes(q);
}

/** Valid coordinates for an item, or null. Never converts a missing pin to 0,0. */
export function itemCoordinates(
  item: FunderNewEmptyHouse | FunderNewReadyPlan,
  category: FunderNewCategory,
): { lat: number; lng: number } | null {
  if (category === 'empty') {
    const house = item as FunderNewEmptyHouse;
    return readCoordinate(house.latitude, house.longitude);
  }
  const plan = item as FunderNewReadyPlan;
  return readCoordinate(plan.request_latitude, plan.request_longitude);
}

/** Kept for compatibility with the earlier route-local helper name. */
export const hasCoordinates = itemCoordinates;
