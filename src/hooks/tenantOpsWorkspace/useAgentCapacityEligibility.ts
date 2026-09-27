/**
 * Reads tops_agent_capacity_eligibility() — a pass-through of the EXISTING
 * gate (v_agent_daily_eligibility). Never recompute this client-side; render
 * exactly what the RPC returns. Note: the underlying view does not exclude
 * reversed collections, so a same-day reversal can inflate today_pct —
 * carried through here, not hidden.
 */
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

const anyDb = supabase as any;

export interface AgentCapacityEligibility {
  agent_id: string;
  agent_name: string | null;
  active_count: number;
  expected_daily: number;
  paid_today: number;
  today_pct: number;
  effective_pct: number;
  tenants_due: number;
  tenants_paid_today: number;
  coverage_today: number;
  weekly_plan_count: number;
  weekly_lapsed_count: number;
}

async function fetchAgentCapacityEligibility(): Promise<AgentCapacityEligibility[]> {
  const { data, error } = await anyDb.rpc('tops_agent_capacity_eligibility');
  if (error) throw error;
  return ((data ?? []) as Record<string, any>[]).map((r) => ({
    agent_id: r.agent_id,
    agent_name: r.agent_name ?? null,
    active_count: Number(r.active_count),
    expected_daily: Number(r.expected_daily),
    paid_today: Number(r.paid_today),
    today_pct: Number(r.today_pct),
    effective_pct: Number(r.effective_pct),
    tenants_due: Number(r.tenants_due),
    tenants_paid_today: Number(r.tenants_paid_today),
    coverage_today: Number(r.coverage_today),
    weekly_plan_count: Number(r.weekly_plan_count),
    weekly_lapsed_count: Number(r.weekly_lapsed_count),
  }));
}

export function useAgentCapacityEligibility() {
  return useQuery({
    queryKey: ['tenantOpsWorkspace', 'agentCapacityEligibility'],
    queryFn: fetchAgentCapacityEligibility,
    staleTime: 30_000,
  });
}
