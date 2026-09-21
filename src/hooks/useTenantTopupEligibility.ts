import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

export interface TopupLevel {
  key: string;
  label: string;
  increase_pct: number;
  max_accessible_rent: number;
  deadline: string | null;
  amount_required: number;
  window_open: boolean;
  reached: boolean;
}

export interface TopupEligibilityRow {
  tenant_id: string;
  rent_request_id: string;
  tenant_name: string | null;
  tenant_phone: string | null;
  district: string | null;
  rr_status: string | null;
  registration_type: string | null;
  agent_id: string | null;
  agent_name: string | null;
  agent_phone: string | null;
  rent_amount: number;
  total_amount: number;
  daily_amount: number;
  amount_repaid: number;
  outstanding: number;
  expected_to_date: number | null;
  pct_covered: number;
  term_start: string | null;
  term_end: string | null;
  term_days: number | null;
  repayment_frequency: string | null;
  is_live: boolean;
  last_payment_at: string | null;
  reached_on: string | null;
  days_after_cycle: number;
  tier_key: string;
  increase_pct: number;
  eligible: boolean;
  max_topup_amount: number;
  max_accessible_rent: number;
  amount_to_qualifying: number;
  amount_to_same_amount: number;
  days_left_in_cycle: number;
  levels: TopupLevel[];
}

export interface TopupEligibilityRules {
  qualifying_pct: number;
  same_amount_pct: number;
  tiers: { key: string; label?: string; max_days_after_cycle: number | null; increase_pct: number }[];
}

export interface TopupEligibilitySummary {
  tenants: number;
  eligible: number;
  within_cycle: number;
  within_one_month: number;
  within_two_months: number;
  beyond_two_months: number;
  same_amount_only: number;
  not_eligible: number;
  total_expected: number;
  total_paid: number;
  total_outstanding: number;
  total_topup_accessible: number;
}

export interface TopupEligibilityResult {
  rules: TopupEligibilityRules;
  as_of: string;
  total: number;
  limit: number;
  offset: number;
  summary: TopupEligibilitySummary;
  rows: TopupEligibilityRow[];
}

export const TOPUP_TIER_LABELS: Record<string, string> = {
  within_cycle: 'Within payment cycle',
  within_one_month: 'Within one month after cycle',
  within_two_months: 'Within two months after cycle',
  beyond_two_months: 'Beyond two months — same rate only',
  same_amount_only: 'Same amount only, no increase',
  not_eligible: 'Not eligible',
};

interface Params {
  search?: string;
  agentId?: string | null;
  tier?: string | null;
  limit?: number;
  offset?: number;
}

export function useTenantTopupEligibility(params: Params = {}) {
  const { search = '', agentId = null, tier = null, limit = 100, offset = 0 } = params;
  return useQuery({
    queryKey: ['tenant-topup-eligibility', search, agentId, tier, limit, offset],
    queryFn: async (): Promise<TopupEligibilityResult> => {
      const { data, error } = await supabase.rpc('get_tenant_topup_eligibility', {
        p_search: search || null,
        p_agent_id: agentId,
        p_tier: tier,
        p_limit: limit,
        p_offset: offset,
      });
      if (error) throw error;
      return data as unknown as TopupEligibilityResult;
    },
    staleTime: 60_000,
  });
}

export function useTopupEligibilityRules() {
  return useQuery({
    queryKey: ['tenant-topup-eligibility-rules'],
    queryFn: async (): Promise<TopupEligibilityRules> => {
      const { data, error } = await supabase.rpc('tenant_topup_eligibility_rules');
      if (error) throw error;
      return data as unknown as TopupEligibilityRules;
    },
    staleTime: 300_000,
  });
}

export function useSaveTopupEligibilityRules() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (rules: TopupEligibilityRules) => {
      const { data, error } = await supabase.rpc('set_tenant_topup_eligibility_rules', {
        p_rules: rules as unknown as never,
      });
      if (error) throw error;
      return data as unknown as TopupEligibilityRules;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['tenant-topup-eligibility-rules'] });
      qc.invalidateQueries({ queryKey: ['tenant-topup-eligibility'] });
    },
  });
}
