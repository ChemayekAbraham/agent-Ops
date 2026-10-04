/**
 * useWalletBreakdownData — cached agent-earnings/commission-payout data for
 * WalletBreakdown.tsx. Previously this component ran both queries fresh
 * every time the sheet opened, with no caching between opens.
 *
 * Two independent React Query hooks (own query keys) rather than one
 * combined fetch — earnings and commission payouts don't depend on each
 * other, so mounting both hooks lets React Query fire both queryFns
 * concurrently with no explicit Promise.all needed at the call site. The
 * profile-name lookup inside useAgentEarnings DOES depend on the earnings
 * rows (needs the source_user_ids first), so that one stays sequential —
 * there's nothing to parallelize there.
 *
 * 30s staleTime (vs. useWalletBalance's 8s) — this data changes far less
 * often than a live balance, so reopening the sheet within 30s is an
 * instant cache hit. No realtime channel: low-frequency data, and a new
 * commission/earning row is always accompanied by a general_ledger insert
 * that useWalletBalance's own channel already reacts to elsewhere: adding
 * this table to that channel's invalidate fan-out isn't worth the
 * coupling risk to the highest-stakes hook for this low-value win.
 */
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { trackRequest } from "@/lib/costMonitor";

const BREAKDOWN_STALE_MS = 30_000;
const BREAKDOWN_GC_MS = 5 * 60_000;

export interface AgentEarningRow {
  id: string;
  amount: number;
  earning_type: string;
  description: string | null;
  source_user_id: string | null;
  created_at: string;
  source_user_name?: string | null;
}

export interface AgentCommissionPayoutRow {
  id: string;
  amount: number;
  status: string;
  created_at: string;
  processed_at: string | null;
}

export const walletBreakdownEarningsKey = (userId: string | null | undefined) =>
  ["wallet-breakdown-earnings", userId ?? ""] as const;

export const walletBreakdownPayoutsKey = (userId: string | null | undefined) =>
  ["wallet-breakdown-payouts", userId ?? ""] as const;

async function fetchAgentEarnings(userId: string): Promise<AgentEarningRow[]> {
  trackRequest("db", "wallet_breakdown_earnings");
  const { data: earningsData, error } = await supabase
    .from("agent_earnings")
    .select("*")
    .eq("agent_id", userId)
    .order("created_at", { ascending: false })
    .limit(50);
  if (error) throw error;
  const rows = earningsData ?? [];
  if (rows.length === 0) return [];

  // Depends on the IDs above — stays sequential, nothing to parallelize.
  const sourceUserIds = [...new Set(rows.filter((e) => e.source_user_id).map((e) => e.source_user_id as string))];
  let userNamesMap: Record<string, string> = {};
  if (sourceUserIds.length > 0) {
    const { data: profiles } = await supabase.from("profiles").select("id, full_name").in("id", sourceUserIds);
    userNamesMap = (profiles ?? []).reduce((acc, p) => {
      acc[p.id] = p.full_name || "Unknown User";
      return acc;
    }, {} as Record<string, string>);
  }

  return rows.map((e) => ({
    ...e,
    source_user_name: e.source_user_id ? userNamesMap[e.source_user_id] : null,
  })) as AgentEarningRow[];
}

async function fetchAgentCommissionPayouts(userId: string): Promise<AgentCommissionPayoutRow[]> {
  trackRequest("db", "wallet_breakdown_payouts");
  const { data, error } = await supabase
    .from("agent_commission_payouts")
    .select("*")
    .eq("agent_id", userId)
    .eq("status", "approved")
    .order("created_at", { ascending: false })
    .limit(20);
  if (error) throw error;
  return (data ?? []) as AgentCommissionPayoutRow[];
}

export function useAgentEarnings(userId: string | null | undefined, enabled = true) {
  const query = useQuery<AgentEarningRow[]>({
    queryKey: walletBreakdownEarningsKey(userId),
    enabled: !!userId && enabled,
    queryFn: () => fetchAgentEarnings(userId as string),
    staleTime: BREAKDOWN_STALE_MS,
    gcTime: BREAKDOWN_GC_MS,
    refetchOnWindowFocus: false,
  });
  return { earnings: query.data ?? [], isLoading: query.isLoading, refetch: query.refetch };
}

export function useAgentCommissionPayouts(userId: string | null | undefined, enabled = true) {
  const query = useQuery<AgentCommissionPayoutRow[]>({
    queryKey: walletBreakdownPayoutsKey(userId),
    enabled: !!userId && enabled,
    queryFn: () => fetchAgentCommissionPayouts(userId as string),
    staleTime: BREAKDOWN_STALE_MS,
    gcTime: BREAKDOWN_GC_MS,
    refetchOnWindowFocus: false,
  });
  return { payouts: query.data ?? [], isLoading: query.isLoading, refetch: query.refetch };
}
