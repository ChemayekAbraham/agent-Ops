import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

export interface LandlordOpsTotals {
  total: number;
  verified: number;
  pending: number;
  rejected: number;
  resubmitted: number;
  verified_human: number;
  verified_auto: number;
  has_tenants: number;
  no_tenants: number;
  smartphone: number;
  occupied_monthly_revenue: number;
  empty_monthly_revenue: number;
}

export type LandlordVerificationStatus = 'pending' | 'verified' | 'rejected' | 'resubmitted';

export interface LandlordOpsRow {
  id: string;
  name: string;
  phone: string;
  verified: boolean;
  verification_status: LandlordVerificationStatus;
  verification_source: string;
  verification_reason: string | null;
  verification_updated_at: string | null;
  has_smartphone: boolean | null;
  mobile_money_name: string | null;
  mobile_money_number: string | null;
  number_of_houses: number | null;
  bank_name: string | null;
  account_number: string | null;
  monthly_rent: number | null;
  caretaker_name: string | null;
  caretaker_phone: string | null;
  tin: string | null;
  electricity_meter_number: string | null;
  water_meter_number: string | null;
  village: string | null;
  district: string | null;
  region: string | null;
  property_address: string | null;
  tenant_id: string | null;
  registered_by: string | null;
  managed_by_agent_id: string | null;
  house_category: string | null;
  number_of_rooms: number | null;
  created_at: string;
  tenant_count: number;
  agent_name: string | null;
  agent_phone: string | null;
  tenant_name: string | null;
  tenant_phone_profile: string | null;
}

export type LandlordCategory =
  | 'all'
  | 'verified'
  | 'pending'
  | 'rejected'
  | 'resubmitted'
  | 'has_tenants'
  | 'no_tenants';
export type LandlordPendingFilter = 'all' | 'has_address' | 'has_phone' | 'has_smartphone' | 'has_bank' | 'has_momo';
export type LandlordSort = 'newest' | 'oldest' | 'highest_rent';

async function invokeLandlordOps<T>(body: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.functions.invoke('landlord-ops', { body });
  if (error) throw error;
  if ((data as any)?.error) throw new Error((data as any).error);
  return data as T;
}

export function useLandlordOpsTotals(enabled = true) {
  return useQuery({
    queryKey: ['landlord-ops', 'totals'],
    queryFn: () => invokeLandlordOps<{ totals: LandlordOpsTotals }>({ action: 'totals' }),
    staleTime: 60_000,
    enabled,
  });
}

export interface UseLandlordOpsListParams {
  search: string;
  sort: LandlordSort;
  category: LandlordCategory;
  pendingFilter: LandlordPendingFilter;
  page: number;
  perPage: number;
  enabled?: boolean;
  /** ISO timestamp — filters on the landlord's STATE date (see docs below). */
  dateFrom?: string | null;
  dateTo?: string | null;
}

export function useLandlordOpsList(params: UseLandlordOpsListParams) {
  const {
    search, sort, category, pendingFilter, page, perPage, enabled = true,
    dateFrom = null, dateTo = null,
  } = params;
  const offset = Math.max(0, (page - 1) * perPage);
  return useQuery({
    queryKey: ['landlord-ops', 'rows', { search, sort, category, pendingFilter, page, perPage, dateFrom, dateTo }],
    queryFn: () =>
      invokeLandlordOps<{
        rows: LandlordOpsRow[];
        totals: LandlordOpsTotals;
        totalMatched: number;
        limit: number;
        offset: number;
      }>({
        action: 'rows',
        search,
        sort,
        category,
        pending_filter: pendingFilter,
        limit: perPage,
        offset,
        ...(dateFrom ? { date_from: dateFrom } : {}),
        ...(dateTo ? { date_to: dateTo } : {}),
      }),
    placeholderData: keepPreviousData,
    staleTime: 30_000,
    enabled,
  });
}

/**
 * Landlord verification counts scoped to the ACTIVE search + date range.
 * Mirrors what the Houses verification queue does with
 * `ops_house_listing_status_counts`: a chip and the list it opens can never
 * disagree because both come from the same filtered set.
 *
 * Date semantics: the range is applied to the landlord's STATE date —
 * registration date for pending, decision date for verified / rejected /
 * resubmitted.
 */
export interface LandlordScopedCounts {
  all: number;
  verified: number;
  pending: number;
  rejected: number;
  resubmitted: number;
  has_tenants: number;
  no_tenants: number;
  verified_human: number;
  verified_auto: number;
  smartphone: number;
  occupied_monthly_revenue: number;
  empty_monthly_revenue: number;
}

export function useLandlordScopedCounts(params: {
  search: string;
  dateFrom?: string | null;
  dateTo?: string | null;
  enabled?: boolean;
}) {
  const { search, dateFrom = null, dateTo = null, enabled = true } = params;
  return useQuery({
    queryKey: ['landlord-ops', 'scoped-counts', { search, dateFrom, dateTo }],
    queryFn: () =>
      invokeLandlordOps<{ counts: LandlordScopedCounts }>({
        action: 'scoped_counts',
        search,
        ...(dateFrom ? { date_from: dateFrom } : {}),
        ...(dateTo ? { date_to: dateTo } : {}),
      }),
    placeholderData: keepPreviousData,
    staleTime: 30_000,
    enabled,
  });
}

/** One row per landlord for the PDF export — never a partial page. */
export interface LandlordReportRow {
  id: string;
  name: string | null;
  phone: string | null;
  status: string | null;
  source: string | null;
  verification_reason: string | null;
  /** Existing service-centre verification comment recorded on the landlord. */
  service_center_comment?: string | null;
  verification_updated_at: string | null;
  verified_by_name: string | null;
  created_at: string | null;
  activity_at: string | null;
  village: string | null;
  district: string | null;
  region: string | null;
  property_address: string | null;
  monthly_rent: number | null;
  number_of_houses: number | null;
  number_of_rooms: number | null;
  house_category: string | null;
  has_smartphone: boolean | null;
  mobile_money_name: string | null;
  mobile_money_number: string | null;
  bank_name: string | null;
  account_number: string | null;
  caretaker_name: string | null;
  caretaker_phone: string | null;
  tin: string | null;
  tenant_count: number | null;
  has_tenant: boolean | null;
  agent_name: string | null;
  agent_phone: string | null;
  tenant_name: string | null;
  tenant_phone: string | null;
}

/** Imperative fetch (called on the Export click, not on render). */
export async function fetchLandlordReport(params: {
  category: LandlordCategory;
  pendingFilter: LandlordPendingFilter;
  search: string;
  dateFrom?: string | null;
  dateTo?: string | null;
}) {
  const { category, pendingFilter, search, dateFrom = null, dateTo = null } = params;
  return invokeLandlordOps<{ rows: LandlordReportRow[]; totalMatched: number }>({
    action: 'report',
    category,
    pending_filter: pendingFilter,
    search,
    ...(dateFrom ? { date_from: dateFrom } : {}),
    ...(dateTo ? { date_to: dateTo } : {}),
  });
}