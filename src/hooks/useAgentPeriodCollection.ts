import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

/**
 * Per-agent PERIOD collection figures worked out by tops_agent_period_collection with the same rule as
 * Tenant Ops Home (bill timetable up to today, payments limited to each Rent Plan's bill, cancelled payments
 * excluded, money above the bill reported separately). Read-only; every figure and percentage is computed in SQL.
 */

export interface AgentPeriodRow {
  agent_id: string | null;
  agent_name: string;
  expected_ugx: number;
  collected_ugx: number;
  short_ugx: number;
  coverage_pct: number | null;
  plans_billed: number;
  paid_ahead_ugx: number;
  paid_ahead_plans: number;
}

export interface AgentPeriodTotals {
  expected_ugx: number;
  collected_ugx: number;
  short_ugx: number;
  coverage_pct: number | null;
  paid_ahead_ugx: number;
  paid_ahead_no_bill_ugx: number;
  paid_ahead_above_bill_ugx: number;
  plans_billed: number;
}

export interface AgentPeriodCollection {
  window: { start_day: string; end_day: string; asof: string; days: number };
  basis: string;
  totals: AgentPeriodTotals;
  rows: AgentPeriodRow[];
}

const anyDb = supabase as any;

export function useAgentPeriodCollection(startIso: string, endIso: string, agentId: string | null = null, enabled = true) {
  return useQuery({
    enabled,
    queryKey: ['tenant-ops', 'agent-period-collection', startIso, endIso, agentId],
    queryFn: async (): Promise<AgentPeriodCollection> => {
      const { data, error } = await anyDb.rpc('tops_agent_period_collection', {
        p_start: startIso,
        p_end: endIso,
        p_agent_id: agentId,
      });
      if (error) throw error;
      return data as AgentPeriodCollection;
    },
    staleTime: 60_000,
    placeholderData: keepPreviousData,
  });
}
