import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { kampalaTodayYmd, kampalaYmd } from '@/lib/kampalaDays';
import {
  daysBetweenYmd,
  summarisePayouts,
  type AllocationRowInput,
  type PayoutRowInput,
  type UncoveredBucket,
  type UncoveredPlanRow,
} from '@/lib/agentMonitoringUncovered';

const PAGE_SIZE = 1000;
const CLOCK_CHUNK = 500;
const IN_CHUNK = 100;
const PROFILE_CHUNK = 300;
const PARALLEL = 3;

export interface UncoveredPlans {
  tenantPaying: UncoveredPlanRow[];
  awaiting: UncoveredPlanRow[];
  /** Kampala day the days-since-funding figures were counted to. */
  asOf: string;
}

export const UNCOVERED_QUERY_KEY = ['am-uncovered-plans'] as const;

interface ActivePlan {
  id: string;
  tenant_id: string;
  agent_id: string | null;
  rent_amount: number | null;
  total_repayment: number | null;
  amount_repaid: number | null;
  status: string;
  funded_at: string | null;
  disbursed_at: string | null;
  created_at: string;
}

interface ProfileRow {
  id: string;
  full_name: string | null;
  phone: string | null;
}

const chunk = <T,>(items: readonly T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size) as T[]);
  return out;
};

/** Run async work over chunks, a few at a time. */
async function inChunks<T, R>(items: readonly T[], size: number, work: (slice: T[]) => Promise<R[]>): Promise<R[]> {
  const slices = chunk(items, size);
  const out: R[] = [];
  for (let i = 0; i < slices.length; i += PARALLEL) {
    const results = await Promise.all(slices.slice(i, i + PARALLEL).map(work));
    results.forEach((rows) => out.push(...rows));
  }
  return out;
}

/**
 * Every active Rent Plan the payout clock does not cover, with the tenant, agent and landlord
 * payout facts the two Agent Monitoring lists show. Read-only: bucket from `am_plan_clock`
 * (one call per chunk of plan ids), then batched reads of profiles, landlord payouts and float
 * allocations for just those plans.
 */
export async function fetchUncoveredPlans(): Promise<UncoveredPlans> {
  const plans: ActivePlan[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await supabase
      .from('rent_requests')
      .select('id, tenant_id, agent_id, rent_amount, total_repayment, amount_repaid, status, funded_at, disbursed_at, created_at')
      .in('status', ['funded', 'disbursed', 'repaying'])
      .order('id')
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(error.message);
    plans.push(...((data ?? []) as unknown as ActivePlan[]));
    if ((data ?? []).length < PAGE_SIZE) break;
  }

  const buckets = new Map<string, UncoveredBucket>();
  const clock = await inChunks(plans.map((p) => p.id), CLOCK_CHUNK, async (ids) => {
    const { data, error } = await supabase.rpc('am_plan_clock', { p_rent_request_ids: ids });
    if (error) throw new Error(error.message);
    return (data ?? []) as unknown as { rent_request_id: string; bucket: string }[];
  });
  clock.forEach((row) => {
    if (row.bucket === 'tenant_paying_no_landlord' || row.bucket === 'awaiting_landlord') {
      buckets.set(row.rent_request_id, row.bucket);
    }
  });

  const covered = plans.filter((p) => buckets.has(p.id));
  const planIds = covered.map((p) => p.id);
  const peopleIds = Array.from(new Set(covered.flatMap((p) => [p.tenant_id, p.agent_id]).filter((id): id is string => Boolean(id))));

  const [profiles, payouts, allocations] = await Promise.all([
    inChunks(peopleIds, PROFILE_CHUNK, async (ids) => {
      const { data, error } = await supabase.from('profiles').select('id, full_name, phone').in('id', ids);
      if (error) throw new Error(error.message);
      return (data ?? []) as ProfileRow[];
    }),
    inChunks(planIds, IN_CHUNK, async (ids) => {
      const { data, error } = await supabase
        .from('landlord_payouts')
        .select('rent_request_id, status, amount')
        .in('rent_request_id', ids);
      if (error) throw new Error(error.message);
      return (data ?? []) as unknown as (PayoutRowInput & { rent_request_id: string })[];
    }),
    // Float allocations are readable by finance and executive roles; where a role cannot read
    // them the list still loads, it just cannot show a part-paid amount.
    inChunks(planIds, IN_CHUNK, async (ids) => {
      const { data, error } = await supabase
        .from('agent_landlord_float_allocations')
        .select('rent_request_id, status, allocated_amount, paid_out_amount')
        .in('rent_request_id', ids);
      if (error) throw new Error(error.message);
      return (data ?? []) as unknown as (AllocationRowInput & { rent_request_id: string })[];
    }),
  ]);

  const profileMap = new Map(profiles.map((p) => [p.id, p]));
  const payoutsByPlan = new Map<string, PayoutRowInput[]>();
  payouts.forEach((p) => payoutsByPlan.set(p.rent_request_id, [...(payoutsByPlan.get(p.rent_request_id) ?? []), p]));
  const allocationsByPlan = new Map<string, AllocationRowInput[]>();
  allocations.forEach((a) => allocationsByPlan.set(a.rent_request_id, [...(allocationsByPlan.get(a.rent_request_id) ?? []), a]));

  const today = kampalaTodayYmd();
  const tenantPaying: UncoveredPlanRow[] = [];
  const awaiting: UncoveredPlanRow[] = [];
  covered.forEach((plan) => {
    const bucket = buckets.get(plan.id) as UncoveredBucket;
    const tenant = profileMap.get(plan.tenant_id);
    const agent = plan.agent_id ? profileMap.get(plan.agent_id) : undefined;
    const fundedOn = kampalaYmd(plan.funded_at ?? plan.disbursed_at ?? plan.created_at);
    const repaid = Number(plan.amount_repaid ?? 0);
    const total = Number(plan.total_repayment ?? 0);
    const row: UncoveredPlanRow = {
      id: plan.id,
      bucket,
      tenantId: plan.tenant_id,
      tenantName: tenant?.full_name || 'Unnamed tenant',
      tenantPhone: tenant?.phone ?? null,
      agentId: plan.agent_id,
      agentName: agent?.full_name || (plan.agent_id ? 'Unnamed agent' : 'No agent'),
      fundedAmount: Number(plan.rent_amount ?? 0),
      totalRepayment: total,
      repaid,
      stillOwed: Math.max(0, total - repaid),
      fundedOn,
      daysSinceFunding: daysBetweenYmd(fundedOn, today),
      payout: summarisePayouts(payoutsByPlan.get(plan.id) ?? [], allocationsByPlan.get(plan.id) ?? []),
      pipelineStatus: plan.status,
    };
    (bucket === 'tenant_paying_no_landlord' ? tenantPaying : awaiting).push(row);
  });

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
