import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

/**
 * "Landlords Funded" statistics for Landlord Ops.
 *
 * A landlord counts as FUNDED when a rent request naming that landlord has a
 * non-null `funded_at` inside the selected window (the moment company money was
 * committed for that landlord's property). The RPC also returns the immediately
 * preceding window of equal length so every figure carries a comparison.
 */

export interface FundedSummary {
  landlords_funded: number;
  requests_funded: number;
  total_funded: number;
  total_repayment: number;
  total_fees: number;
  avg_per_landlord: number;
  avg_per_request: number;
  verified_landlords: number;
  unverified_landlords: number;
  with_momo: number;
  with_bank: number;
  districts_covered: number;
  agents_involved: number;
  first_time_landlords: number;
  repeat_landlords: number;
}

export interface FundedPrevious {
  landlords_funded: number;
  requests_funded: number;
  total_funded: number;
  total_repayment: number;
  districts_covered: number;
}

export interface FundedDistrictRow {
  district: string;
  region: string;
  landlords_funded: number;
  requests_funded: number;
  total_funded: number;
  total_repayment: number;
  avg_per_landlord: number;
  previous_landlords_funded: number;
  previous_total_funded: number;
}

export interface FundedAgentRow {
  agent_name: string;
  service_centre: string;
  landlords_funded: number;
  requests_funded: number;
  total_funded: number;
  districts: number;
  previous_landlords_funded: number;
  previous_total_funded: number;
}

export interface FundedServiceCentreRow {
  service_centre: string;
  agents: number;
  landlords_funded: number;
  requests_funded: number;
  total_funded: number;
  previous_landlords_funded: number;
  previous_total_funded: number;
}

export interface FundedDailyRow {
  day: string;
  landlords_funded: number;
  requests_funded: number;
  total_funded: number;
}

export interface FundedLandlordRow {
  landlord_id: string;
  landlord_name: string;
  landlord_phone: string | null;
  verified: boolean;
  district: string;
  region: string;
  tenant_name: string | null;
  agent_name: string;
  service_centre: string;
  funded_at: string;
  rent_amount: number;
  total_repayment: number;
  status: string;
  payout_channel: string;
  first_time: boolean;
}

export interface LandlordFundedStats {
  range: { from: string; to: string; previous_from: string; previous_to: string; days: number };
  summary: FundedSummary;
  previous: FundedPrevious;
  by_district: FundedDistrictRow[];
  by_agent: FundedAgentRow[];
  by_service_centre: FundedServiceCentreRow[];
  daily: FundedDailyRow[];
  rows: FundedLandlordRow[];
}

/** Turn the dashboard's `yyyy-MM-dd` inputs into an inclusive ISO window. */
export function fundedRangeIso(dateFrom: string, dateTo: string) {
  const fromIso = dateFrom ? new Date(`${dateFrom}T00:00:00`).toISOString() : null;
  // `to` is exclusive in the RPC, so push it to the end of the chosen day.
  const toIso = dateTo ? new Date(`${dateTo}T23:59:59.999`).toISOString() : null;
  return { fromIso, toIso };
}

export async function fetchLandlordFundedStats(params: {
  dateFrom?: string;
  dateTo?: string;
  search?: string | null;
}): Promise<LandlordFundedStats> {
  const { fromIso, toIso } = fundedRangeIso(params.dateFrom ?? '', params.dateTo ?? '');
  const { data, error } = await supabase.rpc('ops_landlord_funded_stats', {
    p_date_from: fromIso,
    p_date_to: toIso,
    p_search: params.search?.trim() || null,
  });
  if (error) throw error;
  return data as unknown as LandlordFundedStats;
}

/** Lightweight query powering the LANDLORDS FUNDED stat tile. */
export function useLandlordFundedStats(params: {
  dateFrom?: string;
  dateTo?: string;
  search?: string | null;
  enabled?: boolean;
}) {
  return useQuery({
    queryKey: ['landlord-funded-stats', params.dateFrom ?? '', params.dateTo ?? '', params.search ?? ''],
    queryFn: () => fetchLandlordFundedStats(params),
    enabled: params.enabled !== false,
    staleTime: 60_000,
  });
}
