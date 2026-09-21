import type { HouseOpportunity } from '@/components/agent/EmptyHouseDetailSheet';
import type { PlanDetail } from '@/components/partner/SelfPortfolioPlanDetailSheet';

export type FunderNewCategory = 'empty' | 'ready';
export type AmountBucket = 'all' | 'under_300k' | '300k_600k' | 'over_600k';

export interface FunderNewFilters {
  search: string;
  location: string;
  amount: AmountBucket;
}

export interface FunderNewEmptyHouse extends HouseOpportunity {
  created_at?: string | null;
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
