import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import {
  type TopupEligibilityResult,
  type TopupEligibilityRow,
} from '@/hooks/useTenantTopupEligibility';
import {
  useAgentRegistrationControl,
  type RegistrationControlRow,
} from '@/hooks/useAgentRegistrationControl';
import { useAgentPeriodCollection } from '@/hooks/useAgentPeriodCollection';

/**
 * Management Overview is a read-only roll-up. Every tenant figure comes straight
 * from `get_tenant_topup_eligibility` (the authoritative top-up eligibility
 * report) and every agent restriction figure from `get_agent_registration_control`.
 * Agent portfolio totals are sums of that same tenant data — no separate
 * calculation of rent, dues, payments or eligibility is performed here.
 *
 * Those tenant and portfolio money figures are ALL-TIME (the whole Rent Plan). The PERIOD figures for the chosen
 * dates (expected, collected, short, paid ahead) come from tops_agent_period_collection, which applies the same
 * rule as Tenant Ops Home, and are merged onto each agent row as the period_* fields.
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
  /** The chosen dates (tops_agent_period_collection, Home rule). Null while loading or if the report is unavailable. */
  period_expected: number | null;
  period_collected: number | null;
  period_short: number | null;
  period_coverage_pct: number | null;
  period_paid_ahead: number | null;
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
      const out: Record<string, number> = {};
      // Chunked so a large portfolio never overflows the request URL.
      for (let i = 0; i < tenantIds.length; i += 200) {
        const chunk = tenantIds.slice(i, i + 200);
        const { data, error } = await supabase
          .from('rent_requests')
          .select('tenant_id, rent_amount, created_at')
          .in('tenant_id', chunk)
          .order('created_at', { ascending: true });
        if (error) throw error;
        for (const r of data ?? []) {
          const tid = r.tenant_id as string | null;
          if (!tid || out[tid] !== undefined) continue;
          out[tid] = Number(r.rent_amount ?? 0);
        }
      }
      return out;
    },
  });
}

/** Page size of get_tenant_topup_eligibility (its own maximum). */
const ELIGIBILITY_PAGE = 500;
/** Safety ceiling only (50,000 tenants); never reached in practice, and if it ever is, the tab says so. */
const ELIGIBILITY_MAX_PAGES = 100;

/**
 * The eligibility report pages at 500 rows. Agent portfolio totals must cover the agent's whole portfolio, so every
 * page of the SAME authoritative report is read, however many there are (there is no fixed row cap). The server's own
 * `total` is kept next to the number of rows actually loaded so the tab can warn if the two ever differ.
 * Rows are de-duplicated by Rent Plan because the report orders by % covered, which can tie between pages.
 */
function useAllEligibilityRows(params: { search: string; agentId: string | null; tier: string | null }) {
  const { search, agentId, tier } = params;
  return useQuery({
    queryKey: ['tenant-topup-eligibility', 'all-pages', search, agentId, tier],
    staleTime: 60_000,
    queryFn: async (): Promise<TopupEligibilityResult & { loaded: number }> => {
      const page = async (offset: number) => {
        const { data, error } = await supabase.rpc('get_tenant_topup_eligibility', {
          p_search: search || null,
          p_agent_id: agentId,
          p_tier: tier,
          p_limit: ELIGIBILITY_PAGE,
          p_offset: offset,
        });
        if (error) throw error;
        return data as unknown as TopupEligibilityResult;
      };
      const first = await page(0);
      const byPlan = new Map<string, TopupEligibilityRow>();
      for (const r of first.rows ?? []) byPlan.set(r.rent_request_id, r);
      let total = Number(first.total ?? byPlan.size);
      for (let n = 1; n < ELIGIBILITY_MAX_PAGES && n * ELIGIBILITY_PAGE < total; n += 1) {
        const next = await page(n * ELIGIBILITY_PAGE);
        if (!(next.rows ?? []).length) break;
        for (const r of next.rows) byPlan.set(r.rent_request_id, r);
        total = Math.max(total, Number(next.total ?? 0));
      }
      return { ...first, total, rows: [...byPlan.values()], loaded: byPlan.size };
    },
  });
}

export function useTenantOpsManagementOverview(params: {
  search?: string;
  agentId?: string | null;
  tier?: string | null;
  /** The dates for the period columns (ISO). Left out, the period figures are not requested. */
  periodStartIso?: string;
  periodEndIso?: string;
} = {}) {
  const { search = '', agentId = null, tier = null, periodStartIso, periodEndIso } = params;

  const eligibility = useAllEligibilityRows({ search, agentId, tier });
  const registration = useAgentRegistrationControl({ status: 'all', limit: 500 });
  const hasPeriod = Boolean(periodStartIso && periodEndIso);
  const period = useAgentPeriodCollection(periodStartIso ?? '', periodEndIso ?? '', null, hasPeriod);

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

    const periodByAgent = new Map<string, NonNullable<typeof period.data>['rows'][number]>();
    if (hasPeriod) for (const r of period.data?.rows ?? []) if (r.agent_id) periodByAgent.set(r.agent_id, r);

    // An agent who has Rent Plans billed in the period but no tenant in the eligibility report still gets a row,
    // so the period columns can be added up to Home's figures.
    const ids = new Set<string>([...grouped.keys(), ...regByAgent.keys(), ...periodByAgent.keys()]);
    const rows: ManagementAgentRow[] = [];
    for (const id of ids) {
      const list = grouped.get(id) ?? [];
      const reg = regByAgent.get(id);
      const per = periodByAgent.get(id);
      const periodReady = hasPeriod && Boolean(period.data);
      const totalExpected = list.reduce((s, t) => s + Number(t.total_amount ?? 0), 0);
      const totalCollected = list.reduce((s, t) => s + Number(t.amount_repaid ?? 0), 0);
      const totalOutstanding = list.reduce((s, t) => s + Number(t.outstanding ?? 0), 0);
      const totalArrears = list.reduce((s, t) => s + t.arrears, 0);
      const avgPct = list.length
        ? Math.round((list.reduce((s, t) => s + Number(t.pct_covered ?? 0), 0) / list.length) * 10) / 10
        : 0;
      rows.push({
        agent_id: id,
        agent_name: reg?.full_name ?? list[0]?.agent_name ?? per?.agent_name ?? null,
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
        period_expected: periodReady ? Number(per?.expected_ugx ?? 0) : null,
        period_collected: periodReady ? Number(per?.collected_ugx ?? 0) : null,
        period_short: periodReady ? Number(per?.short_ugx ?? 0) : null,
        period_coverage_pct: periodReady ? (per?.coverage_pct ?? null) : null,
        period_paid_ahead: periodReady ? Number(per?.paid_ahead_ugx ?? 0) : null,
      });
    }
    return rows.sort((a, b) => b.total_outstanding - a.total_outstanding);
  }, [tenants, registration.data, period.data, hasPeriod]);

  return {
    tenants,
    agents,
    rules: eligibility.data?.rules,
    registrationRules: registration.data?.rules,
    asOf: eligibility.data?.as_of,
    totalTenants: eligibility.data?.total ?? 0,
    /** How many tenants were actually read; below totalTenants only if the report grew past the safety ceiling. */
    loadedTenants: eligibility.data?.loaded ?? 0,
    summary: eligibility.data?.summary,
    /** Period totals for ALL agents (the Home rule); null until read or if unavailable. */
    periodTotals: hasPeriod ? period.data?.totals ?? null : null,
    periodWindow: hasPeriod ? period.data?.window ?? null : null,
    periodLoading: hasPeriod && period.isLoading,
    periodError: hasPeriod && period.isError,
    isLoading: eligibility.isLoading || registration.isLoading,
    error: eligibility.error ?? registration.error,
  };
}
