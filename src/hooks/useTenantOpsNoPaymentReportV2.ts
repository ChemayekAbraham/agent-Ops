/**
 * Tenant Ops "N+ Days No Payment" report. Reads get_tenant_ops_no_payment_report_v2() — the same report as
 * the original with the threshold as a parameter (1 to 365). With 20 it returns exactly what the original
 * returns. days_since_last_payment, progress_pct and the per-agent N+ / N+10 / N+20 counts are all computed
 * server-side; nothing here recomputes them.
 */
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import type { TenantOpsDormantTenant } from '@/hooks/useTenantOpsNoPaymentReport';

const anyDb = supabase as any;

export type { TenantOpsDormantTenant };

export interface TenantOpsAgentNoPaymentSummaryV2 {
  agent_id: string | null;
  label: string;
  /** Tenants with at least N days without a payment. */
  gte_min: number;
  /** ... at least N + 10 days. */
  gte_min_10: number;
  /** ... at least N + 20 days. */
  gte_min_20: number;
}

export interface TenantOpsNoPaymentReportV2 {
  as_of: string;
  min_days: number;
  tenants: TenantOpsDormantTenant[];
  total_min_days: number;
  agent_summary: TenantOpsAgentNoPaymentSummaryV2[];
}

/** `agentId` filters the tenant list; agent_summary always covers every agent. */
export function useTenantOpsNoPaymentReportV2(minDays: number, agentId?: string | null, enabled: boolean = true) {
  return useQuery({
    queryKey: ['tenant-ops-no-payment-report-v2', minDays, agentId ?? null],
    enabled,
    staleTime: 120_000,
    refetchInterval: 180_000,
    placeholderData: (previous) => previous,
    queryFn: async (): Promise<TenantOpsNoPaymentReportV2> => {
      const { data, error } = await anyDb.rpc('get_tenant_ops_no_payment_report_v2', {
        p_min_days: minDays,
        p_agent_id: agentId ?? null,
      });
      if (error) throw new Error(error.message);
      return data as TenantOpsNoPaymentReportV2;
    },
  });
}
