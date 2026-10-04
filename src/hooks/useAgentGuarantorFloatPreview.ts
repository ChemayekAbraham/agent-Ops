import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

/**
 * Engine baseline. Counting of quiet days starts Monday 2026-08-24 00:00 EAT.
 * Nothing before this date is considered, so no historical backlog is flagged.
 */
export const GUARANTOR_BASELINE_DATE = '2026-08-24';

export type GuarantorTenantRow = {
  rent_request_id: string;
  tenant_id: string | null;
  tenant_name: string | null;
  cadence: 'daily' | 'weekly' | 'fortnightly' | 'irregular' | 'unknown';
  pay_count: number;
  last_collection_at: string | null;
  quiet_start: string;
  days_quiet: number;
  flag_threshold: number;
  advance_threshold: number;
  daily_repayment: number;
  outstanding: number;
  missing_amount: number;
  float_allocation: number;
  residual_advance: number;
  state: 'flagged' | 'advance_ready';
};

export type GuarantorAgentRow = {
  agent_id: string;
  agent_name: string | null;
  agent_phone: string | null;
  float_available: number;
  total_shortfall: number;
  amount_to_deduct: number;
  float_remaining: number;
  residual_advance: number;
  tenant_count: number;
  advance_ready_count: number;
  tenants: GuarantorTenantRow[];
};

export type GuarantorFloatPreview = {
  baseline_date: string;
  as_of: string;
  agents: GuarantorAgentRow[];
  totals: {
    agents: number;
    tenants: number;
    advance_ready_tenants: number;
    total_shortfall: number;
    float_available: number;
    amount_to_deduct: number;
    float_remaining: number;
    residual_advance: number;
  };
};

/**
 * Single round trip: the whole parent→child tree (agents + their missing tenants,
 * float available, amount to deduct, float remaining) is aggregated server-side
 * by `get_agent_guarantor_float_preview`. Read-only — it moves no money.
 */
export function useAgentGuarantorFloatPreview(asOf?: string) {
  return useQuery({
    queryKey: ['agent-guarantor-float-preview', GUARANTOR_BASELINE_DATE, asOf ?? 'today'],
    queryFn: async (): Promise<GuarantorFloatPreview> => {
      const { data, error } = await supabase.rpc('get_agent_guarantor_float_preview', {
        p_baseline_date: GUARANTOR_BASELINE_DATE,
        p_as_of: asOf ?? null,
      });
      if (error) throw error;
      return data as unknown as GuarantorFloatPreview;
    },
    staleTime: 60_000,
  });
}
