import type { HouseOpportunity } from '@/components/agent/EmptyHouseDetailSheet';
import type { PlanDetail } from '@/components/partner/SelfPortfolioPlanDetailSheet';

export type FunderNewCategory = 'empty' | 'ready';
export type AmountBucket = 'all' | 'under_300k' | '300k_600k' | 'over_600k';

/** Sort names accepted by `agent_list_empty_house_opportunities` (p_sort). */
export type FunderNewSort = 'nearest' | 'recommended' | 'newest' | 'rent_low' | 'rent_high';

export interface FunderNewFilters {
  search: string;
  location: string;
  amount: AmountBucket;
  sort: FunderNewSort;
}

/**
 * Where the list/map is anchored. `device` is the real browser position,
 * `area` is a manually chosen map area. They are never conflated.
 */
export interface FunderNewOrigin {
  lat: number;
  lng: number;
  source: 'device' | 'area';
  radiusKm: number | null;
  label: string;
}

export interface FunderNewEmptyHouse extends HouseOpportunity {
  created_at?: string | null;
  /** Server-computed km from the p_near_lat/p_near_lng passed to the read RPC. */
  distance_km?: number | null;
}

export interface FunderNewReadyPlan extends PlanDetail {
  held_by?: string | null;
  hold_expires_at?: string | null;
}

export interface FunderNewMarketSummary {
  houseCount: number;
  totalRentNeeded: number;
  avgMonthlyRent: number;
}

export interface FunderNewListResult<T> {
  items: T[];
  total: number;
  limitation?: string | null;
}

export interface FunderNewSelectionItem {
  id: string;
  category: FunderNewCategory;
  title: string;
  place: string;
  amount: number;
  monthlyReturn: number | null;
  termLabel: string;
  imageUrl: string | null;
}

/** An honest travel estimate. `roadRouting` is false for straight-line maths. */
export interface FunderNewDistance {
  km: number;
  label: string;
  /** True only when a real routing service produced the figure. */
  roadRouting: boolean;
}
