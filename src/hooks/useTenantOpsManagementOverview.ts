import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import {
  useTenantTopupEligibility,
  type TopupEligibilityRow,
} from '@/hooks/useTenantTopupEligibility';
import {
  useAgentRegistrationControl,
  type RegistrationControlRow,
} from '@/hooks/useAgentRegistrationControl';

/**
 * Management Overview is a read-only roll-up. Every tenant figure comes straight
 * from `get_tenant_topup_eligibility` (the authoritative top-up eligibility
 * report) and every agent restriction figure from `get_agent_registration_control`.
 * Agent portfolio totals are sums of that same tenant data — no separate
 * calculation of rent, dues, payments or eligibility is performed here.
 */

export interface ManagementTenantRow extends TopupEligibilityRow {
  initial_rent: number | null;
  arrears: number;
  pct_remaining: number;
  cycle_status: 'in_cycle' | 'within_one_month' | 'within_two_months' | 'beyond_two_months' | 'completed';
}

export interface ManagementAgentRow {
  agent_id: string;
  agent_name: string | null;
  active_tenants: number;
  tenants_tracked: number;
  total_expected: number;
  total_collected: number;
  total_outstanding: number;
  total_arrears: number;
  portfolio_pct: number;
  avg_pct_covered: number;
  prev_month_pct: number | null;
  prev_month_expected: number;
  prev_month_collected: number;
  can_register: boolean;
  blocked: boolean;
  restricted: boolean;
  override_active: boolean;
  period_start: string | null;
  period_end: string | null;
}

function cycleStatus(row: TopupEligibilityRow): ManagementTenantRow['cycle_status'] {
  if (row.outstanding <= 0) return 'completed';
  if (row.days_after_cycle <= 0) return 'in_cycle';
  if (row.days_after_cycle <= 30) return 'within_one_month';
  if (row.days_after_cycle <= 60) return 'within_two_months';
  return 'beyond_two_months';
}

function useInitialRents(tenantIds: string[]) {
  const key = tenantIds.slice().sort().join(',');
  return useQuery({
    queryKey: ['management-overview-initial-rents', key],
    enabled: tenantIds.length > 0,
    staleTime: 5 * 60_000,
    queryFn: async (): Promise<Record<string, number>> => {
      const { data, error } = await supabase
        .from('rent_requests')
        .select('tenant_id, rent_amount, created_at')
        .in('tenant_id', tenantIds)
        .order('created_at', { ascending: true });
      if (error) throw error;
      const out: Record<string, number> = {};
      for (const r of data ?? []) {
        const tid = r.tenant_id as string | null;
        if (!tid || out[tid] !== undefined) continue;
        out[tid] = Number(r.rent_amount ?? 0);
      }
      return out;
    },
  });
}

export function useTenantOpsManagementOverview(params: {
  search?: string;
  agentId?: string | null;
  tier?: string | null;
  limit?: number;
} = {}) {
  const { search = '', agentId = null, tier = null, limit = 300 } = params;

  const eligibility = useTenantTopupEligibility({ search, agentId, tier, limit });
  const registration = useAgentRegistrationControl({ status: 'all', limit: 500 });

  const tenantIds = useMemo(
    () => (eligibility.data?.rows ?? []).map((r) => r.tenant_id).filter(Boolean),
    [eligibility.data],
  );
  const initialRents = useInitialRents(tenantIds);

  const tenants = useMemo<ManagementTenantRow[]>(() => {
    const rents = initialRents.data ?? {};
    return (eligibility.data?.rows ?? []).map((row) => {
      const expectedToDate = row.expected_to_date ?? null;
      const arrears = expectedToDate == null ? 0 : Math.max(0, expectedToDate - row.amount_repaid);
      return {
        ...row,
        initial_rent: rents[row.tenant_id] ?? null,
        arrears,
        pct_remaining: Math.max(0, 100 - (row.pct_covered ?? 0)),
        cycle_status: cycleStatus(row),
      };
    });
  }, [eligibility.data, initialRents.data]);

  const agents = useMemo<ManagementAgentRow[]>(() => {
    const regByAgent = new Map<string, RegistrationControlRow>();
    for (const r of registration.data?.rows ?? []) regByAgent.set(r.agent_id, r);

    const grouped = new Map<string, ManagementTenantRow[]>();
    for (const t of tenants) {
      if (!t.agent_id) continue;
      const list = grouped.get(t.agent_id) ?? [];
      list.push(t);
      grouped.set(t.agent_id, list);
    }

    const ids = new Set<string>([...grouped.keys(), ...regByAgent.keys()]);
    const rows: ManagementAgentRow[] = [];
    for (const id of ids) {
      const list = grouped.get(id) ?? [];
      const reg = regByAgent.get(id);
      const totalExpected = list.reduce((s, t) => s + Number(t.total_amount ?? 0), 0);
      const totalCollected = list.reduce((s, t) => s + Number(t.amount_repaid ?? 0), 0);
      const totalOutstanding = list.reduce((s, t) => s + Number(t.outstanding ?? 0), 0);
      const totalArrears = list.reduce((s, t) => s + t.arrears, 0);
      const avgPct = list.length
        ? Math.round((list.reduce((s, t) => s + Number(t.pct_covered ?? 0), 0) / list.length) * 10) / 10
        : 0;
      rows.push({
        agent_id: id,
        agent_name: reg?.full_name ?? list[0]?.agent_name ?? null,
        active_tenants: reg?.active_tenants ?? list.filter((t) => t.is_live).length,
        tenants_tracked: list.length,
        total_expected: totalExpected,
        total_collected: totalCollected,
        total_outstanding: totalOutstanding,
        total_arrears: totalArrears,
        portfolio_pct: totalExpected > 0
          ? Math.min(100, Math.round((totalCollected / totalExpected) * 1000) / 10)
          : 0,
        avg_pct_covered: avgPct,
        prev_month_pct: reg?.prev_pct ?? null,
        prev_month_expected: Number(reg?.prev_expected ?? 0),
        prev_month_collected: Number(reg?.prev_collected ?? 0),
        can_register: !(reg?.blocked ?? false),
        blocked: reg?.blocked ?? false,
        restricted: reg?.restricted ?? false,
        override_active: Boolean(reg?.override_id),
        period_start: reg?.period_start ?? null,
        period_end: reg?.period_end ?? null,
      });
    }
    return rows.sort((a, b) => b.total_outstanding - a.total_outstanding);
  }, [tenants, registration.data]);

  return {
    tenants,
    agents,
    rules: eligibility.data?.rules,
    registrationRules: registration.data?.rules,
    asOf: eligibility.data?.as_of,
    totalTenants: eligibility.data?.total ?? 0,
    summary: eligibility.data?.summary,
    isLoading: eligibility.isLoading || registration.isLoading,
    error: eligibility.error ?? registration.error,
  };
}
