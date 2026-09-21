import type {
  AmountBucket,
  FunderNewCategory,
  FunderNewEmptyHouse,
  FunderNewFilters,
  FunderNewReadyPlan,
  FunderNewSelectionItem,
} from './types';
import { formatHouseCategory, prettyName } from '@/lib/formatting';

const MONTHLY_RETURN_RATE = 0.15;

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
  return category === 'empty' ? 'Empty houses' : 'Houses with ready tenants';
}

export function emptyHouseTitle(house: FunderNewEmptyHouse): string {
  return house.title?.trim() || formatHouseCategory(house.house_category) || 'Empty house';
}

export function emptyHousePlace(house: FunderNewEmptyHouse): string {
  return [house.village, house.sub_county, house.district].filter(Boolean).join(', ') || house.region || 'Location on file';
}

export function readyPlanTitle(plan: FunderNewReadyPlan): string {
  const home = formatHouseCategory(plan.house_category);
  const area = plan.request_city || plan.tenant_location;
  return area ? `${home} in ${prettyName(area)}` : home;
}

export function readyPlanPlace(plan: FunderNewReadyPlan): string {
  return plan.tenant_location || plan.request_city || 'Location on file';
}

export function readyPlanTerm(plan: FunderNewReadyPlan): string {
  if (plan.duration_days && plan.duration_days > 0) {
    const months = Math.max(1, Math.round(plan.duration_days / 30));
    return `${months} ${months === 1 ? 'month' : 'months'}`;
  }
  return plan.repayment_cadence ? prettyName(plan.repayment_cadence) : 'Term on file';
}

export function itemAmount(category: FunderNewCategory, item: FunderNewEmptyHouse | FunderNewReadyPlan): number {
  return category === 'empty'
    ? toNumber((item as FunderNewEmptyHouse).monthly_rent)
    : toNumber((item as FunderNewReadyPlan).funding_amount);
}

export function itemMonthlyReturn(category: FunderNewCategory, item: FunderNewEmptyHouse | FunderNewReadyPlan): number | null {
  if (category === 'empty') {
    const house = item as FunderNewEmptyHouse;
    const provided = toNumber(house.partner_monthly_return);
    return provided > 0 ? provided : Math.round(toNumber(house.monthly_rent) * MONTHLY_RETURN_RATE);
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

export function toSelectionItem(category: FunderNewCategory, item: FunderNewEmptyHouse | FunderNewReadyPlan): FunderNewSelectionItem {
  const id = category === 'empty'
    ? (item as FunderNewEmptyHouse).house_id
    : (item as FunderNewReadyPlan).rent_request_id;
  return {
    id,
    category,
    title: category === 'empty' ? emptyHouseTitle(item as FunderNewEmptyHouse) : readyPlanTitle(item as FunderNewReadyPlan),
    place: category === 'empty' ? emptyHousePlace(item as FunderNewEmptyHouse) : readyPlanPlace(item as FunderNewReadyPlan),
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

export function hasCoordinates(item: FunderNewEmptyHouse | FunderNewReadyPlan, category: FunderNewCategory) {
  const lat = category === 'empty'
    ? toNumber((item as FunderNewEmptyHouse).latitude)
    : toNumber((item as FunderNewReadyPlan).request_latitude);
  const lng = category === 'empty'
    ? toNumber((item as FunderNewEmptyHouse).longitude)
    : toNumber((item as FunderNewReadyPlan).request_longitude);
  return Number.isFinite(lat) && Number.isFinite(lng) && (lat !== 0 || lng !== 0)
    ? { lat, lng }
    : null;
}
