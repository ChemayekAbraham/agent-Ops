import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { kampalaTodayYmd } from '@/lib/kampalaDays';
import type { PayoutKind, UncoveredBucket, UncoveredPlanRow } from '@/lib/agentMonitoringUncovered';

const anyDb = supabase as any;

/** Rows per call. The server pages the list; the two lists together are a few hundred plans. */
const PAGE_SIZE = 500;

export interface UncoveredPlans {
  tenantPaying: UncoveredPlanRow[];
  awaiting: UncoveredPlanRow[];
  /** Kampala day the days-since-funding figures were counted to. */
  asOf: string;
}

export const UNCOVERED_QUERY_KEY = ['am-uncovered-plans'] as const;

/** One row of `am_uncovered_plans` (SECURITY DEFINER, gated by `_am_staff_ok()`). */
interface UncoveredRpcRow {
  rent_request_id: string;
  bucket: UncoveredBucket;
  tenant_id: string;
  tenant_name: string | null;
  tenant_phone: string | null;
  agent_id: string | null;
  agent_name: string | null;
  funded_amount: number | string | null;
  total_repayment: number | string | null;
  repaid: number | string | null;
  still_owed: number | string | null;
  funded_on: string | null;
  days_since_funding: number | null;
  payout_kind: PayoutKind;
  payout_paid_amount: number | string | null;
  payout_allocated_amount: number | string | null;
  pipeline_status: string;
  total_rows: number | string;
}

const money = (value: unknown): number => {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
};

export function toUncoveredRow(row: UncoveredRpcRow): UncoveredPlanRow {
  return {
    id: row.rent_request_id,
    bucket: row.bucket,
    tenantId: row.tenant_id,
    tenantName: row.tenant_name || 'Unnamed tenant',
    tenantPhone: row.tenant_phone ?? null,
    agentId: row.agent_id,
    agentName: row.agent_name || (row.agent_id ? 'Unnamed agent' : 'No agent'),
    fundedAmount: money(row.funded_amount),
    totalRepayment: money(row.total_repayment),
    repaid: money(row.repaid),
    stillOwed: money(row.still_owed),
    fundedOn: row.funded_on,
    daysSinceFunding: row.days_since_funding,
    payout: {
      kind: row.payout_kind,
      paidAmount: money(row.payout_paid_amount),
      allocatedAmount: money(row.payout_allocated_amount),
    },
    pipelineStatus: row.pipeline_status,
  };
}

/**
 * Every active Rent Plan the payout clock does not cover, with the tenant, agent and landlord
 * payout facts the two Agent Monitoring lists show. Read-only and one call: `am_uncovered_plans`
 * does the clock, the names and the payout / float-allocation facts on the server (so a staff role
 * that cannot read float allocations still sees the part-paid amount) and is read page by page.
 */
export async function fetchUncoveredPlans(): Promise<UncoveredPlans> {
  const today = kampalaTodayYmd();
  const rows: UncoveredRpcRow[] = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const { data, error } = await anyDb.rpc('am_uncovered_plans', {
      p_as_at: today,
      p_limit: PAGE_SIZE,
      p_offset: offset,
    });
    if (error) throw new Error(error.message);
    const page = (data ?? []) as unknown as UncoveredRpcRow[];
    rows.push(...page);
    const total = page.length > 0 ? Number(page[0].total_rows) : 0;
    if (page.length === 0 || offset + page.length >= total) break;
  }

  const tenantPaying: UncoveredPlanRow[] = [];
  const awaiting: UncoveredPlanRow[] = [];
  rows.forEach((row) => (row.bucket === 'tenant_paying_no_landlord' ? tenantPaying : awaiting).push(toUncoveredRow(row)));
  return { tenantPaying, awaiting, asOf: today };
}

/** The two lists, loaded once and shared by both tabs and the PDF export. */
export function useAgentMonitoringUncovered(enabled = true) {
  return useQuery({
    queryKey: UNCOVERED_QUERY_KEY,
    queryFn: fetchUncoveredPlans,
    enabled,
    staleTime: 60_000,
  });
}
