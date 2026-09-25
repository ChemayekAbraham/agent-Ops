/**
 * Tenant Ops "20+ Days No Payment" tab.
 *
 * Reads get_tenant_ops_no_payment_report() — a single call, no client-side
 * arithmetic beyond formatting. days_since_last_payment, progress_pct and the
 * agent 20+/30+/40+ counts are all computed server-side from
 * v_rent_plan_schedule.last_pay_date (agent_collections UNION repayments).
 */
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

const anyDb = supabase as any;

export interface TenantOpsDormantTenant {
  tenant_id: string;
  tenant_name: string | null;
  tenant_account_number: string | null;
  agent_id: string | null;
  agent_name: string;
  date_of_last_payment: string;
  days_since_last_payment: number;
  expected_daily_payment: number;
  outstanding_balance: number;
  total_amount_paid: number;
  progress_pct: number;
  tenant_status: string;
}

export interface TenantOpsAgentNoPaymentSummary {
  agent_id: string | null;
  label: string;
  gte_20: number;
  gte_30: number;
  gte_40: number;
}

export interface TenantOpsNoPaymentReport {
  as_of: string;
  tenants: TenantOpsDormantTenant[];
  total_20_plus: number;
  agent_summary: TenantOpsAgentNoPaymentSummary[];
}

/** `agentId` filters the tenant list; agent_summary always covers every agent. */
export function useTenantOpsNoPaymentReport(agentId?: string | null, enabled: boolean = true) {
  return useQuery({
    queryKey: ['tenant-ops-no-payment-report', agentId ?? null],
    enabled,
    staleTime: 120_000,
    refetchInterval: 180_000,
    queryFn: async (): Promise<TenantOpsNoPaymentReport> => {
      const { data, error } = await anyDb.rpc('get_tenant_ops_no_payment_report', {
        p_agent_id: agentId ?? null,
      });
      if (error) throw new Error(error.message);
      return data as TenantOpsNoPaymentReport;
    },
  });
}
