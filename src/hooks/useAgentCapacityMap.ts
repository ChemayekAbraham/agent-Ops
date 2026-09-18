import { useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

export const ACTIVE_RENT_STATUSES = [
  'pending', 'agent_verified', 'tenant_ops_approved',
  'agent_ops_approved', 'landlord_ops_approved',
  'coo_approved', 'funded', 'repaying',
];
export const AGENT_RENT_CAP_UGX = 100_000_000;

/**
 * Daily Eligibility Law (new):
 *   An agent is UNBLOCKED and rated "Good" (green) as soon
 *   as EITHER yesterday's OR today's collections reach 20%
 *   of their expected daily rent. Today's progress counts
 *   live — the moment an agent crosses the 20% line today,
 *   their rating flips up and they may post new rent
 *   requests immediately. If neither yesterday nor today
 *   is at 20%, they stay BLOCKED until they catch up.
 *
 *   Agents with no active rent collections yet (Starter)
 *   are always allowed to post their first request.
 */
export const DAILY_ELIGIBILITY_THRESHOLD = 0.50;

/**
 * New-agent onboarding rule:
 *   A brand-new agent who has not yet reached NEW_AGENT_TENANT_THRESHOLD
 *   active tenants is in the "new agent" phase. During this phase they may
 *   post rent requests up to NEW_AGENT_RENT_CAP_UGX per tenant and are NOT
 *   regulated by daily collection performance — we want to give new agents
 *   room to build their book. The moment they reach the tenant threshold
 *   they "graduate" and the Daily Eligibility Law (above) takes over,
 *   gating new posts on their daily collection performance.
 */
export const NEW_AGENT_TENANT_THRESHOLD = 10;
export const NEW_AGENT_RENT_CAP_UGX = 2_000_000;

/**
 * Weekly "Good Standing" unlock:
 *   If, looking at the last 7 days of saved daily eligibility history, an
 *   agent was rated "Good" (green) or better on at least
 *   GOOD_DAYS_UNLOCK_THRESHOLD distinct days, they earn UNLIMITED posting for
 *   the current week: they may post any new rent request, for any amount,
 *   with no per-tenant cap and no daily block. This rewards agents who proved
 *   strong collection behaviour last week. Applies to EVERY agent.
 */
export const GOOD_DAYS_UNLOCK_THRESHOLD = 2;
/** Sentinel per-tenant max used to represent "no cap" (unlimited posting). */
export const UNLIMITED_PER_TENANT_MAX = Number.MAX_SAFE_INTEGER;

/**
 * Daily rating tiers based on the BEST of yesterday's and today's
 * COVERAGE-SAFE collection ratios. The server view
 * `v_agent_daily_eligibility` caps every tenant's contribution at that
 * tenant's own `daily_repayment`, so over-collecting from one tenant can
 * no longer cover for tenants who paid nothing.
 *
 *   ≥ 75%        → Very Good  (emerald, allowed)
 *   50% – <75%   → Good       (green,   allowed)
 *   15% – <50%   → Fair       (amber,   BLOCKED)
 *   5%  – <15%   → Bad        (orange,  BLOCKED)
 *   < 5%         → Very Bad   (red,     BLOCKED)
 *
 * TENANT COVERAGE (2026-08-31 correction): `effective_pct` coming from the
 * server is ALREADY coverage-safe — a tenant who paid nothing contributes
 * nothing, and a tenant who over-paid is capped at their own daily amount.
 * The previous client-side "demote one/two tiers by coverage" step therefore
 * punished the same coverage shortfall a SECOND time and produced absurd
 * labels (e.g. 50% of the daily book collected shown as "Very Bad").
 * Coverage now only does one thing: "Very Good" stays unreachable unless
 * every due tenant paid — the tier is floored at "Good" in that case, never
 * demoted further.
 */
export const DAILY_RATING_THRESHOLDS = {
  very_good: 0.75,
  good:      0.50,
  fair:      0.15,
  bad:       0.05,
} as const;

/** Tenant-coverage bands driving the rating demotion. */
export const COVERAGE_BANDS = { full: 1, partial: 0.50 } as const;

export type DailyRating =
  | 'Very Good' | 'Good' | 'Fair' | 'Bad' | 'Very Bad' | 'Starter';

const RATING_LADDER: DailyRating[] =
  ['Very Good', 'Good', 'Fair', 'Bad', 'Very Bad'];

export function classifyDailyRating(
  active_count: number,
  effective_pct: number,
  coverage = 1,
): DailyRating {
  if (active_count <= 0) return 'Starter';
  let idx: number;
  if (effective_pct >= DAILY_RATING_THRESHOLDS.very_good)   idx = 0;
  else if (effective_pct >= DAILY_RATING_THRESHOLDS.good)   idx = 1;
  else if (effective_pct >= DAILY_RATING_THRESHOLDS.fair)   idx = 2;
  else if (effective_pct >= DAILY_RATING_THRESHOLDS.bad)    idx = 3;
  else                                                     idx = 4;
  const cov = Number.isFinite(coverage) ? coverage : 1;
  // Coverage is already priced into `effective_pct`. It may only block the
  // top tier — never demote further.
  if (idx === 0 && cov < COVERAGE_BANDS.full) idx = 1;
  return RATING_LADDER[Math.min(RATING_LADDER.length - 1, idx)];
}



/**
 * Agent rating tiers based on **last 7 days' Daily Response Rate (DRR)**.
 *
 * We deliberately measure RESPONSIVENESS, not amount collected. An agent
 * whose tenants pay something — even a small amount — every day is doing
 * the hardest part of the job (keeping the tenant engaged) and is rewarded
 * for it.
 *
 *   DRR = (count of (tenant × day) cells in the last 7 days where the
 *          tenant made at least one repayment)
 *         ÷ (active tenants × 7)
 *
 *   ≥ 70%   → Positive  (per-tenant max  UGX 6,000,000)
 *   40–69%  → Fair      (per-tenant max  UGX 3,000,000)
 *   10–39%  → Bad       (per-tenant max  UGX 1,000,000)
 *   < 10%   → Very Bad  (blocked from new rent requests)
 *   no active rents → Starter (per-tenant max UGX 500,000)
 */
export const AGENT_TIER_THRESHOLDS = {
  positive: 0.70,
  fair:     0.40,
  bad:      0.10,
} as const;

export type AgentCapacity = {
  used: number;
  active_count: number;
  /** Distinct tenants the agent is currently collecting from (active rent_requests). */
  active_tenant_count: number;
  /** Distinct tenants who made at least one payment in the last 7 days. Plain-English KPI. */
  paying_tenants_last_week: number;
  /** Distinct tenants the agent has fully marked "Not Funded" (reversed + zero net repayment). */
  unfunded_tenant_count: number;
  /** Last 7-day Daily Response Rate (0..1). Primary tier metric. */
  response_rate: number;
  /** Count of (tenant × day) cells in last 7d where the tenant paid ≥ UGX 1. */
  responding_tenant_days: number;
  /** Maximum possible responding cells = active_count × 7. */
  expected_tenant_days: number;
  /** Secondary stat — total UGX collected in last 7 days. */
  paid_last_week: number;
  /** UGX collected today (since local midnight). */
  paid_today: number;
  /** UGX collected YESTERDAY (the previous calendar day, local midnight to midnight). */
  paid_yesterday: number;
  /** Yesterday's collection ratio = paid_yesterday / expected_daily (0..1+). */
  yesterday_response_pct: number;
  /** Today's collection ratio = paid_today / expected_daily (0..1+). */
  today_response_pct: number;
  /** The ratio actually driving the rating = max(today, yesterday). */
  effective_daily_pct: number;
  /**
   * Daily eligibility status driven by yesterday's performance:
   *   - 'starter' : no active rents to measure → always allowed
   *   - 'good'    : yesterday ≥ 20% of expected daily → allowed today, green
   *   - 'blocked' : yesterday < 20% of expected daily → blocked today, red
   */
  daily_status: 'starter' | 'good' | 'blocked';
  /**
   * Agent-performance ratio actually driving `daily_rating` and the daily
   * gate: share of DUE tenants the agent got to pay (best of today /
   * yesterday). Independent of the UGX expected-daily target.
   */
  performance_pct: number;
  /** 5-tier human label for the agent's own daily performance. */
  daily_rating: DailyRating;
  /** Number of tenants due to pay today (active, non-paused rent plans). */
  tenants_due: number;
  /** Tenants who actually paid today / yesterday. */
  tenants_paid_today: number;
  tenants_paid_yesterday: number;
  /** Coverage = tenants_paid / tenants_due for today / yesterday (0..1). */
  coverage_today: number;
  coverage_yesterday: number;
  /** The coverage actually driving the rating demotion (best of the two). */
  effective_coverage: number;

  /** True iff agent may post a new rent request today. */
  can_post_rent_today: boolean;
  /**
   * Number of DISTINCT days in the last 7 (from saved eligibility history)
   * the agent was rated "Good" (green) or better. Drives the weekly
   * unlimited-posting unlock.
   */
  good_days_last_week: number;
  /**
   * True when the agent qualified for unlimited posting this week
   * (>= GOOD_DAYS_UNLOCK_THRESHOLD good days last week). When true the
   * per-tenant cap and daily block are lifted entirely.
   */
  unlimited_posting: boolean;
  /**
   * True while the agent is still in the new-agent onboarding phase
   * (fewer than NEW_AGENT_TENANT_THRESHOLD active tenants). New agents are
   * capped at NEW_AGENT_RENT_CAP_UGX per tenant and are exempt from daily
   * performance regulation until they graduate.
   */
  is_new_agent: boolean;
  /** Sum of daily_repayment across active (non-unfunded) rent_requests. */
  expected_daily: number;
  /**
   * Plans the server's DAILY gate is actually measuring (daily plans plus
   * weekly plans whose week lapsed unpaid). This — not the raw active
   * rent-request count — decides whether the daily block can apply.
   */
  daily_gate_count: number;
  /** Weekly rent plans, tracked separately from the daily gate. */
  weekly_plan_count: number;
  /** Weekly plans with no collection for a full week (these re-enter the daily gate). */
  weekly_lapsed_count: number;
  /** UGX expected per week across weekly plans (daily equivalent x 7). */
  weekly_expected_week: number;
  /** @deprecated alias of `response_rate` kept for backwards compatibility. */
  repayment_rate: number;
  /** @deprecated kept for backwards compatibility (= daily_expected × 7). */
  expected_weekly: number;
  headroom: number;
  pct: number;
  tier: 'Positive' | 'Fair' | 'Bad' | 'Very Bad' | 'Starter';
  per_tenant_max: number;
};

export function classifyAgent(
  active_count: number,
  response_rate: number,
): { tier: AgentCapacity['tier']; per_tenant_max: number } {
  if (active_count <= 0) return { tier: 'Starter', per_tenant_max: 500_000 };
  if (response_rate >= AGENT_TIER_THRESHOLDS.positive)
    return { tier: 'Positive', per_tenant_max: 6_000_000 };
  if (response_rate >= AGENT_TIER_THRESHOLDS.fair)
    return { tier: 'Fair', per_tenant_max: 3_000_000 };
  if (response_rate >= AGENT_TIER_THRESHOLDS.bad)
    return { tier: 'Bad', per_tenant_max: 1_000_000 };
  return { tier: 'Very Bad', per_tenant_max: 0 };
}

/**
 * Batch-loads rent-request capacity for a set of agent IDs.
 * Rating metric = last 7 days' Daily Response Rate (DRR) — see header.
 * Returns a Map keyed by agent_id.
 */
export function useAgentCapacityMap(agentIds: string[]) {
  const sortedKey = [...agentIds].sort().join(',');
  const queryClient = useQueryClient();

  // Auto-invalidate whenever a tracked rent_request changes (amount_repaid /
  // status flips when ANY allocation/repayment lands — online, offline edge
  // function, cron auto-charge, manual unallocate). Catches every write path
  // so the rating recalculates immediately without per-mutation invalidation.
  useEffect(() => {
    if (agentIds.length === 0) return;
    const channel = supabase
      .channel(`agent-capacity-${sortedKey.slice(0, 32) || 'empty'}`)
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'rent_requests' },
        (payload: any) => {
          const agentId = payload?.new?.agent_id || payload?.old?.agent_id;
          if (!agentId || !agentIds.includes(agentId)) return;
          queryClient.invalidateQueries({ queryKey: ['agent-capacity-map'] });
          queryClient.invalidateQueries({ queryKey: ['agent-rent-capacity-fleet'] });
        },
      )
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'rent_requests' },
        (payload: any) => {
          const agentId = payload?.new?.agent_id;
          if (!agentId || !agentIds.includes(agentId)) return;
          queryClient.invalidateQueries({ queryKey: ['agent-capacity-map'] });
          queryClient.invalidateQueries({ queryKey: ['agent-rent-capacity-fleet'] });
        },
      )
      // Daily Eligibility Law: paid_today / paid_yesterday / effective_pct
      // are derived from `agent_collections` server-side. If we don't listen
      // for inserts here, an agent who just collected (e.g. 25%) still sees
      // the stale "blocked" snapshot — and the rent-request screen blocks
      // them — until the 15s stale window + a refocus. Listening here makes
      // the unblock effectively instant.
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'agent_collections' },
        (payload: any) => {
          const agentId = payload?.new?.agent_id;
          if (!agentId || !agentIds.includes(agentId)) return;
          queryClient.invalidateQueries({ queryKey: ['agent-capacity-map'] });
          queryClient.invalidateQueries({ queryKey: ['agent-rent-capacity-fleet'] });
        },
      )
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [sortedKey, queryClient]); // eslint-disable-line react-hooks/exhaustive-deps

  return useQuery({
    queryKey: ['agent-capacity-map', sortedKey],
    enabled: agentIds.length > 0,
    // Short stale window + always refetch on mount/focus so navigating back
    // to any agent panel reflects collections made seconds ago.
    staleTime: 15_000,
    refetchOnMount: 'always',
    refetchOnWindowFocus: true,
    queryFn: async (): Promise<Map<string, AgentCapacity>> => {
      if (agentIds.length === 0) return new Map();
      const weekAgoISO = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

      // ----- Daily Eligibility Law: SERVER-SIDE source of truth -----
      // Today / yesterday / effective_pct are computed by the Postgres
      // view `v_agent_daily_eligibility` (Africa/Kampala TZ, sourced from
      // `agent_collections`). The browser no longer slices days locally —
      // that previously failed on TZ drift and on the
      // `repayments` ↔ `agent_collections` split.
      const { data: eligRows, error: eligErr } = await supabase.rpc(
        'get_agent_daily_eligibility',
        { p_agent_ids: agentIds },
      );
      const eligibilityRpcSucceeded = !eligErr;
      if (eligErr) {
        // Only use client fallback target math when the server source itself
        // failed. A successful empty result is a valid zero target.
        console.error('[useAgentCapacityMap] eligibility RPC failed', eligErr);
      }
      const eligByAgent = new Map<string, {
        active_count: number;
        expected_daily: number;
        paid_today: number;
        paid_yesterday: number;
        today_pct: number;
        yesterday_pct: number;
        effective_pct: number;
        tenants_due: number;
        tenants_paid_today: number;
        tenants_paid_yesterday: number;
        coverage_today: number;
        coverage_yesterday: number;
        effective_coverage: number;
        raw_today_pct: number;
        raw_yesterday_pct: number;
        weekly_plan_count: number;
        weekly_lapsed_count: number;
        weekly_expected_week: number;
      }>();
      (eligRows || []).forEach((r: any) => {
        eligByAgent.set(r.agent_id, {
          active_count:    Number(r.active_count)    || 0,
          expected_daily:  Number(r.expected_daily)  || 0,
          paid_today:      Number(r.paid_today)      || 0,
          paid_yesterday:  Number(r.paid_yesterday)  || 0,
          today_pct:       Number(r.today_pct)       || 0,
          yesterday_pct:   Number(r.yesterday_pct)   || 0,
          effective_pct:   Number(r.effective_pct)   || 0,
          tenants_due:            Number(r.tenants_due)            || 0,
          tenants_paid_today:     Number(r.tenants_paid_today)      || 0,
          tenants_paid_yesterday: Number(r.tenants_paid_yesterday)  || 0,
          coverage_today:         Number(r.coverage_today)          || 0,
          coverage_yesterday:     Number(r.coverage_yesterday)      || 0,
          effective_coverage:     Number(r.effective_coverage)      || 0,
          raw_today_pct:          Number(r.raw_today_pct)           || 0,
          raw_yesterday_pct:      Number(r.raw_yesterday_pct)       || 0,
          weekly_plan_count:      Number(r.weekly_plan_count)       || 0,
          weekly_lapsed_count:    Number(r.weekly_lapsed_count)     || 0,
          weekly_expected_week:   Number(r.weekly_expected_week)    || 0,
        });
      });


      // ----- Weekly Good-Standing unlock: count "Good"+ days last week -----
      // Pull the last 7 days of saved daily eligibility history for every
      // agent and count DISTINCT days rated "Good" or "Very Good" (green).
      // Two or more such days unlocks unlimited posting for the week.
      const goodDaysByAgent = new Map<string, number>();
      {
        const weekAgoDay = new Date(Date.now() - 7 * 86_400_000)
          .toISOString().slice(0, 10);
        const { data: histRows, error: histErr } = await (supabase as any)
          .from('agent_daily_eligibility_history')
          .select('agent_id, day, rating')
          .in('agent_id', agentIds)
          .gte('day', weekAgoDay);
        if (histErr) {
          console.error('[useAgentCapacityMap] eligibility history failed', histErr);
        }
        const seen = new Map<string, Set<string>>(); // agent → distinct good days
        (histRows || []).forEach((r: any) => {
          if (r.rating !== 'Good' && r.rating !== 'Very Good') return;
          let s = seen.get(r.agent_id);
          if (!s) { s = new Set(); seen.set(r.agent_id, s); }
          s.add(r.day);
        });
        seen.forEach((days, agent) => goodDaysByAgent.set(agent, days.size));
      }

      // 1) Active rent_requests drive both exposure AND expected daily collections
      const { data: active } = await supabase
        .from('rent_requests')
        .select('id, agent_id, tenant_id, total_repayment, amount_repaid, daily_repayment, status, repayment_frequency')
        .in('agent_id', agentIds)
        .in('status', ACTIVE_RENT_STATUSES);

      // 1a) Drop rent_requests the agent has fully "Marked not funded"
      //     (a reversal record exists AND there's no remaining net repayment).
      //     Such tenants should not count toward the agent's expected
      //     response denominator.
      const allActiveIds = (active || []).map((r: any) => r.id);
      const unfundedIds = new Set<string>();
      const unfundedTenantsByAgent = new Map<string, Set<string>>();
      const fallbackBlockedByUnpaidLandlordIds = new Set<string>();
      if (allActiveIds.length > 0) {
        const { data: revs } = await supabase
          .from('agent_tenant_float_reversals')
          .select('rent_request_id')
          .in('rent_request_id', allActiveIds);
        const reversedSet = new Set((revs || []).map((r: any) => r.rent_request_id));
        (active || []).forEach((r: any) => {
          if (reversedSet.has(r.id) && (Number(r.amount_repaid) || 0) <= 0) {
            unfundedIds.add(r.id);
            let s = unfundedTenantsByAgent.get(r.agent_id);
            if (!s) { s = new Set(); unfundedTenantsByAgent.set(r.agent_id, s); }
            if (r.tenant_id) s.add(r.tenant_id);
          }
        });

        if (!eligibilityRpcSucceeded) {
          const { data: allocs } = await supabase
            .from('agent_landlord_float_allocations')
            .select('rent_request_id, status, paid_out_amount')
            .in('rent_request_id', allActiveIds);
          const blockedStatuses = new Set(['open', 'partially_paid', 'return_pending']);
          (allocs || []).forEach((a: any) => {
            const paidOut = Number(a.paid_out_amount) || 0;
            if (blockedStatuses.has(String(a.status || '')) && paidOut <= 0) {
              fallbackBlockedByUnpaidLandlordIds.add(a.rent_request_id);
            }
          });
        }
      }

      const exposure = new Map<string, { used: number; count: number }>();
      const expectedDaily = new Map<string, number>();
      // Fallback-only: number of DAILY plans feeding the gate when the server RPC failed.
      const fallbackGateCount = new Map<string, number>();
      const activeIdToAgent = new Map<string, string>();
      const activeIdToTenant = new Map<string, string>();
      const activeTenantsByAgent = new Map<string, Set<string>>();
      (active || []).forEach((r: any) => {
        if (unfundedIds.has(r.id)) return; // agent marked not funded → excluded from expected
        const owed = Math.max((Number(r.total_repayment) || 0) - (Number(r.amount_repaid) || 0), 0);
        const prev = exposure.get(r.agent_id) || { used: 0, count: 0 };
        exposure.set(r.agent_id, { used: prev.used + owed, count: prev.count + 1 });
        // Daily TARGET mirrors v_agent_daily_eligibility: a tenant only counts
        // once the CFO has funded the landlord float (status 'funded'/'repaying')
        // AND they still owe rent (balance > 0) AND the plan is DAILY — weekly
        // plans are tracked separately and never feed the daily gate here.
        // This fallback only runs if the server eligibility RPC failed.
        const isWeekly = String(r.repayment_frequency || 'daily').toLowerCase() === 'weekly';
        const fundedAndOwing =
          (r.status === 'funded' || r.status === 'repaying') &&
          owed > 0 &&
          !isWeekly &&
          !fallbackBlockedByUnpaidLandlordIds.has(r.id);
        if (fundedAndOwing) {
          expectedDaily.set(
            r.agent_id,
            (expectedDaily.get(r.agent_id) || 0) + (Number(r.daily_repayment) || 0),
          );
          fallbackGateCount.set(r.agent_id, (fallbackGateCount.get(r.agent_id) || 0) + 1);
        }
        activeIdToAgent.set(r.id, r.agent_id);
        if (r.tenant_id) {
          activeIdToTenant.set(r.id, r.tenant_id);
          let s = activeTenantsByAgent.get(r.agent_id);
          if (!s) { s = new Set(); activeTenantsByAgent.set(r.agent_id, s); }
          s.add(r.tenant_id);
        }
      });

      // 2) For each active rent_request, find DISTINCT calendar days in
      //    the last 7 with at least one repayment (any amount). Aggregate
      //    those (rent × day) cells per agent — that's the DRR numerator.
      //    NOTE: today/yesterday day-sums are NO LONGER read here — those
      //    now come from the server-side eligibility view above.
      const paidByAgent = new Map<string, number>();
      const respondingDaysByAgent = new Map<string, number>();
      const payingTenantsByAgent = new Map<string, Set<string>>();
      const activeIds = Array.from(activeIdToAgent.keys());
      if (activeIds.length > 0) {
        const BATCH = 200;
        for (let i = 0; i < activeIds.length; i += BATCH) {
          const slice = activeIds.slice(i, i + BATCH);
          const { data: pays } = await supabase
            .from('repayments')
            .select('rent_request_id, amount, created_at, tenant_id')
            .in('rent_request_id', slice)
            .gte('created_at', weekAgoISO);
          // Per-rent unique paying-day sets
          const dayKeyByRent = new Map<string, Set<string>>();
          (pays || []).forEach((p: any) => {
            const amt = Number(p.amount) || 0;
            const agentId = activeIdToAgent.get(p.rent_request_id);
            if (!agentId) return;
            paidByAgent.set(agentId, (paidByAgent.get(agentId) || 0) + amt);
            if (amt <= 0) return;
            const tenantId = p.tenant_id || activeIdToTenant.get(p.rent_request_id);
            if (tenantId) {
              let pt = payingTenantsByAgent.get(agentId);
              if (!pt) { pt = new Set(); payingTenantsByAgent.set(agentId, pt); }
              pt.add(tenantId);
            }
            const day = (p.created_at as string).slice(0, 10);
            let set = dayKeyByRent.get(p.rent_request_id);
            if (!set) { set = new Set(); dayKeyByRent.set(p.rent_request_id, set); }
            set.add(day);
          });
          // Roll up rent-level day sets into per-agent (rent × day) cell counts
          dayKeyByRent.forEach((daySet, rentId) => {
            const agentId = activeIdToAgent.get(rentId);
            if (!agentId) return;
            respondingDaysByAgent.set(
              agentId,
              (respondingDaysByAgent.get(agentId) || 0) + daySet.size,
            );
          });
        }
      }

      const out = new Map<string, AgentCapacity>();
      agentIds.forEach((id) => {
        const exp = exposure.get(id) || { used: 0, count: 0 };
        const elig = eligByAgent.get(id);
        // Prefer the server-side denominator when present (it applies the
        // same reversed/unfunded filter we apply on the client).
        const dailyExpected = eligibilityRpcSucceeded
          ? (elig?.expected_daily ?? 0)
          : (expectedDaily.get(id) || 0);
        const expected_weekly = dailyExpected * 7;
        const paid_last_week = paidByAgent.get(id) || 0;
        const expected_tenant_days = exp.count * 7;
        const responding_tenant_days = Math.min(
          respondingDaysByAgent.get(id) || 0,
          expected_tenant_days,
        );
        const response_rate =
          expected_tenant_days > 0
            ? Math.min(1, responding_tenant_days / expected_tenant_days)
            : 0;
        const active_tenant_count = activeTenantsByAgent.get(id)?.size || 0;
        const { tier, per_tenant_max: tier_per_tenant_max } =
          classifyAgent(exp.count, response_rate);
        // New-agent phase: under the tenant threshold the agent may post up
        // to UGX 2,000,000 per tenant regardless of the response-rate tier.
        const is_new_agent = active_tenant_count < NEW_AGENT_TENANT_THRESHOLD;
        const base_per_tenant_max = is_new_agent
          ? NEW_AGENT_RENT_CAP_UGX
          : tier_per_tenant_max;
        // Weekly Good-Standing unlock: 2+ "Good" days last week → unlimited.
        const good_days_last_week = goodDaysByAgent.get(id) || 0;
        const unlimited_posting =
          good_days_last_week >= GOOD_DAYS_UNLOCK_THRESHOLD;
        // Daily "Good" floor: any agent who is currently allowed to post
        // today (green banner) is guaranteed at least the new-agent
        // per-tenant floor. We key this off the SAME conditions that drive
        // `can_post_rent_today` below — today's OR yesterday's OR the
        // blended `effective_pct` clearing the daily threshold — so the
        // banner and the per-tenant cap can never disagree. Previously the
        // floor only tracked `effective_pct`, so agents rated Very Bad on
        // the 7-day tier (→ UGX 0 cap) but visibly productive today (e.g.
        // 68% collected) would see the green banner AND a "UGX 0 posting
        // cap" error at the same time.
        const daily_pct_for_floor = Math.max(
          elig?.today_pct ?? 0,
          elig?.yesterday_pct ?? 0,
          elig?.effective_pct ?? 0,
          // Agent-performance basis (tenants reached), same as the rating.
          elig?.coverage_today ?? 0,
          elig?.coverage_yesterday ?? 0,
        );
        const daily_good_floor =
          exp.count > 0 && daily_pct_for_floor >= DAILY_ELIGIBILITY_THRESHOLD
            ? NEW_AGENT_RENT_CAP_UGX
            : 0;
        const per_tenant_max = unlimited_posting
          ? UNLIMITED_PER_TENANT_MAX
          : Math.max(base_per_tenant_max, daily_good_floor);
        const headroom = Math.max(AGENT_RENT_CAP_UGX - exp.used, 0);
        const pct = Math.min(100, Math.round((exp.used / AGENT_RENT_CAP_UGX) * 100));
        // Server-side eligibility values (Africa/Kampala TZ, from
        // agent_collections). Fall back to 0 when the RPC didn't return a
        // row for this agent (= no active rents / no collections found).
        const paid_today_val      = elig?.paid_today     ?? 0;
        const paid_yesterday      = elig?.paid_yesterday ?? 0;
        const today_response_pct  = elig?.today_pct      ?? 0;
        const yesterday_response_pct = elig?.yesterday_pct ?? 0;
        const effective_daily_pct = elig?.effective_pct  ?? 0;
        const tenants_due            = elig?.tenants_due            ?? 0;
        const tenants_paid_today     = elig?.tenants_paid_today     ?? 0;
        const tenants_paid_yesterday = elig?.tenants_paid_yesterday ?? 0;
        const coverage_today         = elig?.coverage_today         ?? 0;
        const coverage_yesterday     = elig?.coverage_yesterday     ?? 0;
        // No server row (or no due tenants) → treat coverage as full so the
        // rating is never demoted on missing data.
        const effective_coverage = tenants_due > 0
          ? (elig?.effective_coverage ?? Math.max(coverage_today, coverage_yesterday))
          : 1;
        /**
         * AGENT-PERFORMANCE RATING (2026-08-31 correction)
         * ------------------------------------------------
         * The rating now measures what the AGENT actually delivered —
         * how many of their due tenants they got to pay today (best of
         * today / yesterday) — and NOT the UGX percentage of the expected
         * daily book. Tenants deciding to pay less than their daily amount
         * no longer drags the agent's rating down: an agent who reached
         * every tenant is rated on that work, whatever the amounts were.
         */
        /**
         * DAILY GATE = the server rule, verbatim (enforce_agent_daily_eligibility):
         *   - gate population = v_agent_daily_eligibility.active_count, i.e.
         *     DAILY plans plus weekly plans whose week lapsed unpaid. Weekly
         *     plans that are on schedule are NOT in this count.
         *   - blocked iff gate population > 0 AND
         *     max(effective_pct, raw_today_pct, raw_yesterday_pct) < threshold.
         * Using exp.count here (all active rent_requests incl. weekly) would
         * make the app disagree with the database trigger.
         */
        const daily_gate_count = eligibilityRpcSucceeded
          ? (elig?.active_count ?? 0)
          : (fallbackGateCount.get(id) || 0);
        const weekly_plan_count    = elig?.weekly_plan_count    ?? 0;
        const weekly_lapsed_count  = elig?.weekly_lapsed_count  ?? 0;
        const weekly_expected_week = elig?.weekly_expected_week ?? 0;
        const server_best_pct = Math.max(
          effective_daily_pct,
          elig?.raw_today_pct ?? 0,
          elig?.raw_yesterday_pct ?? 0,
        );
        const performance_pct = daily_gate_count <= 0
          ? 0
          : tenants_due > 0
            ? Math.max(coverage_today, coverage_yesterday, server_best_pct)
            : server_best_pct;
        const daily_blocked =
          daily_gate_count > 0 && server_best_pct < DAILY_ELIGIBILITY_THRESHOLD;
        let daily_status: AgentCapacity['daily_status'];
        if (daily_gate_count <= 0) daily_status = 'starter';
        else if (daily_blocked) daily_status = 'blocked';
        else daily_status = 'good';
        // Daily performance regulation applies to EVERY agent with a daily
        // gate population, new or not. The database trigger
        // (enforce_agent_daily_eligibility) has no new-agent exemption, so
        // exempting them here made the app promise a post the server refused.
        // New agents remain governed by the smaller per-tenant cap above.
        const can_post_rent_today =
          unlimited_posting ? true : !daily_blocked;
        const daily_rating = classifyDailyRating(daily_gate_count, performance_pct, 1);
        out.set(id, {
          used: exp.used,
          active_count: exp.count,
          tenants_due,
          tenants_paid_today,
          tenants_paid_yesterday,
          coverage_today,
          coverage_yesterday,
          effective_coverage,

          active_tenant_count,
          paying_tenants_last_week: payingTenantsByAgent.get(id)?.size || 0,
          unfunded_tenant_count: unfundedTenantsByAgent.get(id)?.size || 0,
          response_rate,
          responding_tenant_days,
          expected_tenant_days,
          paid_last_week,
          paid_today: paid_today_val,
          paid_yesterday,
          yesterday_response_pct,
          today_response_pct,
          effective_daily_pct,
          daily_status,
          performance_pct,
          daily_rating,
          can_post_rent_today,
          good_days_last_week,
          unlimited_posting,
          is_new_agent,
          expected_daily: dailyExpected,
          daily_gate_count,
          weekly_plan_count,
          weekly_lapsed_count,
          weekly_expected_week,
          repayment_rate: response_rate,
          expected_weekly,
          headroom,
          pct,
          tier,
          per_tenant_max,
        });
      });
      return out;
    },
  });
}