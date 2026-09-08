/**
 * Agent Operations → Reports → Overview data access.
 *
 * Every report is one SECURITY DEFINER RPC round-trip that aggregates on the
 * server (no client-side money maths, no N+1 fan-out):
 *   agent_ops_report_agent            — one agent, tenant-by-tenant history
 *   agent_ops_report_rent_collections — network expected vs collected per agent
 *   agent_ops_report_products         — agent products & services in the window
 *   agent_ops_report_advances         — advance issuance and recovery
 *   agent_ops_report_team_collections — parent/sub-agent team collections
 *
 * Expected figures come from the pinned daily rent-plan schedule
 * (`agent_expected_day_plans`) - the same basis the Agent Operations dashboard
 * reports, so reports and dashboard always tally. Collected comes from
 * `agent_collections`.
 */
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

export interface ReportRange {
  from: string;
  to: string;
}

export interface AgentOption {
  agent_id: string;
  full_name: string | null;
  phone: string | null;
  tenants: number;
}

export interface TeamOption {
  parent_agent_id: string;
  full_name: string | null;
  phone: string | null;
  members: number;
}

/** One itemized receipt on a tenant's ledger (page 3 of the Agent report). */
export interface AgentReportCollectionRow {
  at: string | null;
  ref: string | null;
  expected: number | null;
  collected: number | null;
  shortfall: number | null;
  channel: string | null;
  status: string | null;
}

export interface AgentReportTenantRow {
  rent_request_id: string;
  tenant_name: string | null;
  tenant_phone: string | null;
  rent_amount: number | null;
  outstanding: number | null;
  repayment: number | null;
  collected: number | null;
  collected_to_date: number | null;
  payments: number | null;
  percentage: number | null;
  last_collection_at: string | null;
  status: string | null;
  /**
   * Bio + itemized ledger, added by
   * `20260908210000_agent_ops_report_agent_tenant_ledgers.sql`.
   *
   * Optional on purpose: until that migration is applied the RPC does not send
   * these keys, and the renderer degrades (page 3 explains it is unavailable)
   * instead of throwing. `occupation` is genuinely null for many tenants, so it
   * is rendered as a dash rather than guessed.
   */
  national_id?: string | null;
  occupation?: string | null;
  /**
   * The tenant's own stored address (village/city, sub-county, district), read
   * from `profiles` — NOT `house_listings`, which is the marketplace listing and
   * a different thing entirely. `v_tenant_location_pivot` is the canonical pivot
   * but costs ~792ms to join here, and profiles already holds the columns it is
   * built from.
   */
  location?: string | null;
  house_type?: string | null;
  daily_repayment?: number | null;
  history?: AgentReportCollectionRow[] | null;
  history_truncated?: boolean | null;
}

export interface AgentReportPeriodRow {
  period: string;
  expected: number;
  collected: number;
  payments: number;
  shortfall: number;
  rate: number | null;
}

export interface AgentReport {
  agent: { agent_id?: string; full_name?: string | null; phone?: string | null; territory?: string | null };
  range: ReportRange;
  kpis: {
    assigned_tenants: number;
    active_repaying: number;
    rent_total: number;
    repayment_total: number;
    collected_to_date: number;
    outstanding: number;
    expected_window: number;
    collected_window: number;
    payments_window: number;
    repayment_rate: number | null;
    window_rate: number | null;
  };
  tenants: AgentReportTenantRow[];
  periods: AgentReportPeriodRow[];
}

export interface RentCollectionsRow {
  agent_id: string;
  full_name: string | null;
  phone: string | null;
  repaying_tenants: number;
  expected: number;
  /** All cash this agent took in the window, arrears included. */
  collected: number;
  /** Cash against plans this window actually billed — the numerator for `rate`. */
  collected_on_schedule: number;
  /** The rest: older bills this window never issued, plus unattributed token collections. */
  collected_arrears: number;
  payments: number;
  paid_tenants: number;
  rate: number | null;
  rate_basis?: string;
  status: string;
}

export interface RentCollectionsReport {
  range: ReportRange;
  kpis: {
    total_agents: number;
    active_agents: number;
    expected: number;
    collected: number;
    collected_on_schedule: number;
    collected_arrears: number;
    repaying_tenants: number;
    collection_rate: number | null;
    rate_basis?: string;
  };
  rows: RentCollectionsRow[];
}

export interface ProductsRow {
  sale_id: string;
  agent_id: string | null;
  full_name: string | null;
  phone: string | null;
  product: string | null;
  category: string | null;
  quantity: number;
  status: string;
  value: number;
  recovered: number;
  outstanding: number;
  payment_plan: string | null;
  date: string;
}

export interface ProductsReport {
  range: ReportRange;
  kpis: {
    applications: number;
    approved: number;
    pending: number;
    value_issued: number;
    recovered: number;
    outstanding: number;
    recovery_rate: number | null;
  };
  rows: ProductsRow[];
}

export interface AdvanceRow {
  advance_id: string;
  agent_id: string | null;
  full_name: string | null;
  phone: string | null;
  disbursed: number;
  access_fee: number;
  repaid: number;
  outstanding: number;
  overdue: number;
  installment: number;
  frequency: string | null;
  recovery_rate: number | null;
  status: string | null;
  issued_at: string | null;
  expires_at: string | null;
}

export interface AdvancesReport {
  range: ReportRange;
  kpis: {
    issued_count: number;
    volume: number;
    agents: number;
    repaid: number;
    outstanding: number;
    arrears: number;
    pending_apps: number;
    recovery_rate: number | null;
  };
  stages: { stage: string; count: number; value: number }[];
  rows: AdvanceRow[];
}

export interface TeamMemberRow {
  agent_id: string;
  full_name: string | null;
  phone: string | null;
  is_leader: boolean;
  tenants: number;
  expected: number;
  collected: number;
  collected_on_schedule: number;
  collected_arrears: number;
  payments: number;
  last_collection_at: string | null;
  rate: number | null;
  rate_basis?: string;
  /** Share of the team's total cash — a contribution split, not attainment. */
  group_share: number | null;
  share_of_group_expected: number | null;
}

export interface TeamCollectionsReport {
  range: ReportRange;
  leader: { parent_agent_id?: string; full_name?: string | null; phone?: string | null };
  kpis: {
    sub_agents: number;
    collected: number;
    collected_on_schedule: number;
    collected_arrears: number;
    expected: number;
    tenants: number;
    rate: number | null;
    rate_basis?: string;
    rank: number | null;
    total_teams: number | null;
  };
  rows: TeamMemberRow[];
}

const STALE = 60_000;

export function useReportAgentSearch(search: string, enabled = true) {
  return useQuery({
    queryKey: ['agent-ops-report-agents', search],
    enabled,
    staleTime: STALE,
    queryFn: async (): Promise<AgentOption[]> => {
      const { data, error } = await supabase.rpc('agent_ops_report_agent_search', {
        p_search: search || null,
        p_limit: 40,
      });
      if (error) throw error;
      return (data as unknown as AgentOption[]) ?? [];
    },
  });
}

export function useReportTeamSearch(search: string, enabled = true) {
  return useQuery({
    queryKey: ['agent-ops-report-teams', search],
    enabled,
    staleTime: STALE,
    queryFn: async (): Promise<TeamOption[]> => {
      const { data, error } = await supabase.rpc('agent_ops_report_team_search', {
        p_search: search || null,
        p_limit: 40,
      });
      if (error) throw error;
      return (data as unknown as TeamOption[]) ?? [];
    },
  });
}

export function useAgentReport(agentId: string | null, range: ReportRange | null) {
  return useQuery({
    queryKey: ['agent-ops-report-agent', agentId, range?.from, range?.to],
    enabled: Boolean(agentId && range),
    staleTime: STALE,
    queryFn: async (): Promise<AgentReport> => {
      const { data, error } = await supabase.rpc('agent_ops_report_agent', {
        p_agent_id: agentId as string,
        p_from: range!.from,
        p_to: range!.to,
      });
      if (error) throw error;
      return data as unknown as AgentReport;
    },
  });
}

export function useRentCollectionsReport(range: ReportRange | null) {
  return useQuery({
    queryKey: ['agent-ops-report-rent-collections', range?.from, range?.to],
    enabled: Boolean(range),
    staleTime: STALE,
    queryFn: async (): Promise<RentCollectionsReport> => {
      const { data, error } = await supabase.rpc('agent_ops_report_rent_collections', {
        p_from: range!.from,
        p_to: range!.to,
      });
      if (error) throw error;
      return data as unknown as RentCollectionsReport;
    },
  });
}

export function useProductsReport(range: ReportRange | null) {
  return useQuery({
    queryKey: ['agent-ops-report-products', range?.from, range?.to],
    enabled: Boolean(range),
    staleTime: STALE,
    queryFn: async (): Promise<ProductsReport> => {
      const { data, error } = await supabase.rpc('agent_ops_report_products', {
        p_from: range!.from,
        p_to: range!.to,
      });
      if (error) throw error;
      return data as unknown as ProductsReport;
    },
  });
}

export function useAdvancesReport(range: ReportRange | null) {
  return useQuery({
    queryKey: ['agent-ops-report-advances', range?.from, range?.to],
    enabled: Boolean(range),
    staleTime: STALE,
    queryFn: async (): Promise<AdvancesReport> => {
      const { data, error } = await supabase.rpc('agent_ops_report_advances', {
        p_from: range!.from,
        p_to: range!.to,
      });
      if (error) throw error;
      return data as unknown as AdvancesReport;
    },
  });
}

export function useTeamCollectionsReport(parentAgentId: string | null, range: ReportRange | null) {
  return useQuery({
    queryKey: ['agent-ops-report-team', parentAgentId, range?.from, range?.to],
    enabled: Boolean(parentAgentId && range),
    staleTime: STALE,
    queryFn: async (): Promise<TeamCollectionsReport> => {
      const { data, error } = await supabase.rpc('agent_ops_report_team_collections', {
        p_parent_agent_id: parentAgentId as string,
        p_from: range!.from,
        p_to: range!.to,
      });
      if (error) throw error;
      return data as unknown as TeamCollectionsReport;
    },
  });
}
