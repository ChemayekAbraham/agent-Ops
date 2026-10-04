/**
 * Arrears reads for the agent surfaces.
 *
 * Two SECURITY DEFINER RPCs, one round trip each, both aggregated server-side:
 *   agent_collect_context   — one plan: today's amount PLUS its arrears context
 *   agent_arrears_overview  — one agent: totals plus a per-tenant behind list
 *
 * `agent_collect_context` deliberately replaces the collect dialog's old
 * `agent_expected_collection` call rather than sitting beside it: it delegates
 * to that same function server-side for `expected_today`, so the screen keeps
 * one definition of "what is due today" and arrears cost no extra call.
 *
 * Both are floored at `rent_arrears_go_live()`, so before that day every arrears
 * figure is 0 and every list is empty. Callers therefore need no date check —
 * an empty queue renders as nothing.
 */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import type { CollectContext } from '@/lib/arrearsAllocation';

export type { CollectContext, BehindDay } from '@/lib/arrearsAllocation';

/** One tenant on an agent's arrears book. */
export interface AgentArrearsTenant {
  rent_request_id: string;
  tenant_id: string | null;
  tenant_name: string | null;
  tenant_phone: string | null;
  days_behind: number;
  arrears_ugx: number;
  due_today_ugx: number;
  oldest_open_day: string | null;
}

export interface AgentArrearsOverview {
  agent_id: string;
  go_live: string;
  as_at: string;
  totals: {
    tenants_behind: number;
    arrears_ugx: number;
    due_today_ugx: number;
    days_behind: number;
  };
  tenants: AgentArrearsTenant[];
}

/**
 * These RPCs are newer than the checked-in generated `Database` types, so the
 * typed `supabase.rpc` overloads do not know their names yet. One narrow,
 * documented escape hatch here beats an `any` at every call site; it goes away
 * when the types are next regenerated.
 */
type LooseRpc = (
  fn: string,
  args?: Record<string, unknown>,
) => Promise<{ data: unknown; error: { message: string } | null }>;
const rpc = supabase.rpc.bind(supabase) as unknown as LooseRpc;

export const collectContextKey = (rentRequestId: string | null | undefined) =>
  ['agent-collect-context', rentRequestId] as const;

export const agentArrearsKey = (agentId: string | null | undefined) =>
  ['agent-arrears-overview', agentId] as const;

/**
 * Today's expected amount and this plan's arrears context, in one call.
 *
 * Kept at `staleTime: 0` on purpose — a collection that just landed changes
 * these numbers, and the dialog must never talk an agent through a split that
 * has already happened.
 */
export function useAgentCollectContext(
  rentRequestId: string | null | undefined,
  enabled = true,
) {
  return useQuery({
    queryKey: collectContextKey(rentRequestId),
    enabled: Boolean(rentRequestId) && enabled,
    staleTime: 0,
    retry: 1,
    queryFn: async (): Promise<CollectContext | null> => {
      const { data, error } = await rpc('agent_collect_context', {
        p_rent_request_id: rentRequestId,
      });
      if (error) throw error;
      return (data as CollectContext) ?? null;
    },
  });
}

/** An agent's whole arrears book: totals plus the tenants behind. */
export function useAgentArrears(agentId: string | null | undefined, enabled = true) {
  return useQuery({
    queryKey: agentArrearsKey(agentId),
    enabled: Boolean(agentId) && enabled,
    staleTime: 60_000,
    queryFn: async (): Promise<AgentArrearsOverview | null> => {
      const { data, error } = await rpc('agent_arrears_overview', {
        p_agent_id: agentId,
      });
      if (error) throw error;
      return (data as AgentArrearsOverview) ?? null;
    },
  });
}

/** One Rent Plan whose cycle has ended while a balance remains. */
export interface AgentExpiredCyclePlan {
  rent_request_id: string;
  tenant_id: string | null;
  tenant_name: string | null;
  tenant_phone: string | null;
  status: string | null;
  term_ends_on: string | null;
  days_overdue: number;
  outstanding_ugx: number;
  total_repayment: number;
  amount_repaid: number;
  last_payment_on: string | null;
}

export interface AgentExpiredCycles {
  agent_id: string;
  as_at: string;
  totals: {
    plans: number;
    outstanding_ugx: number;
    oldest_term_end: string | null;
    max_days_overdue: number;
  };
  plans: AgentExpiredCyclePlan[];
}

export const agentExpiredCyclesKey = (agentId: string | null | undefined) =>
  ['agent-expired-cycles', agentId] as const;

/**
 * Rent Plans past their end date that still owe.
 *
 * Deliberately a separate read from `useAgentArrears`. Once a plan's term has
 * passed there are no more days to pin, so `agent_expected_collection` returns
 * 0 and the arrears queue — floored at the go-live date — holds almost none of
 * those days either. The truthful figure for an expired cycle is the plan's own
 * outstanding balance, which is what `agent_expired_cycles` reports.
 */
export function useAgentExpiredCycles(agentId: string | null | undefined, enabled = true) {
  return useQuery({
    queryKey: agentExpiredCyclesKey(agentId),
    enabled: Boolean(agentId) && enabled,
    staleTime: 5 * 60_000,
    queryFn: async (): Promise<AgentExpiredCycles | null> => {
      const { data, error } = await rpc('agent_expired_cycles', {
        p_agent_id: agentId,
      });
      if (error) throw error;
      return (data as AgentExpiredCycles) ?? null;
    },
  });
}

/**
 * Call after a collection is recorded or reversed — both change which days are
 * settled, so every arrears surface must re-read rather than show a stale split.
 */
export function useInvalidateArrears() {
  const queryClient = useQueryClient();
  return (opts?: { rentRequestId?: string | null; agentId?: string | null }) => {
    queryClient.invalidateQueries({ queryKey: ['agent-collect-context'] });
    queryClient.invalidateQueries({ queryKey: ['agent-arrears-overview'] });
    queryClient.invalidateQueries({ queryKey: ['agent-expired-cycles'] });
    if (opts?.rentRequestId) {
      queryClient.invalidateQueries({ queryKey: collectContextKey(opts.rentRequestId) });
    }
    if (opts?.agentId) {
      queryClient.invalidateQueries({ queryKey: agentArrearsKey(opts.agentId) });
      queryClient.invalidateQueries({ queryKey: agentExpiredCyclesKey(opts.agentId) });
    }
  };
}
