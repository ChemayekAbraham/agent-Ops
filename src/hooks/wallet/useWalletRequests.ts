/**
 * useWalletRequests — shared, cached deposit/withdrawal request lists.
 *
 * Before this hook, UserDepositRequests.tsx, UserWithdrawalRequests.tsx,
 * and PendingMovesStrip.tsx each ran their own uncached useState/useEffect
 * fetch, and PendingMovesStrip additionally kept its own realtime channel
 * — so mounting the dashboard wallet card and the full wallet sheet at
 * once (they render the same two request-list components) fired the same
 * two queries twice, plus a third independent query+channel pair for the
 * pending strip.
 *
 * Same convention as useWalletBalance.ts:
 *   staleTime: 8s   — shared subscribers reuse one recent read
 *   gcTime: 5m      — avoids remount storms while navigating wallet dialogs
 *   ONE ref-counted realtime channel per userId, covering BOTH tables,
 *   shared across every subscriber for that user.
 *
 * Query shape mirrors whichever existing component had the more specific
 * server-side filter, so migrating onto this hook doesn't change what
 * data shows up:
 *   - deposit_requests: last 10 by created_at, no status filter (matches
 *     UserDepositRequests' prior select('*')...limit(10)).
 *   - withdrawal_requests: last 10 by created_at, but excluding OLD
 *     pending rows older than 12h (matches UserWithdrawalRequests' prior
 *     `.or('status.neq.pending,created_at.gte.<12h ago>')` — a pending
 *     request from days ago shouldn't clutter the list, a recent one
 *     should).
 * PendingMovesStrip narrows this same cached data to its own "in-flight"
 * status subset client-side instead of issuing a third query.
 */
import { useEffect } from "react";
import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { trackRequest } from "@/lib/costMonitor";

export const depositRequestsKey = (userId: string | null | undefined) =>
  ["deposit-requests", userId ?? ""] as const;

export const withdrawalRequestsKey = (userId: string | null | undefined) =>
  ["withdrawal-requests", userId ?? ""] as const;

const REQUESTS_STALE_MS = 8_000;
const REQUESTS_GC_MS = 5 * 60_000;
const REQUEST_LIMIT = 10;

// Loose row shape — each consumer narrows/casts the fields it needs, same
// as the `select('*')` + `as any[]` pattern the original components used.
export type DepositRequestRow = Record<string, any> & {
  id: string;
  agent_id: string;
  amount: number;
  status: string;
  created_at: string;
};

export type WithdrawalRequestRow = Record<string, any> & {
  id: string;
  amount: number;
  status: string;
  created_at: string;
};

async function fetchDepositRequests(userId: string): Promise<DepositRequestRow[]> {
  trackRequest("db", "deposit_requests_list");
  const { data, error } = await supabase
    .from("deposit_requests")
    .select("*")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(REQUEST_LIMIT);
  if (error) throw error;
  return (data ?? []) as DepositRequestRow[];
}

async function fetchWithdrawalRequests(userId: string): Promise<WithdrawalRequestRow[]> {
  trackRequest("db", "withdrawal_requests_list");
  const twelveHoursAgo = new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString();
  const { data, error } = await supabase
    .from("withdrawal_requests")
    .select("*, manager_approved_at, cfo_approved_at, coo_approved_at")
    .eq("user_id", userId)
    .or(`status.neq.pending,created_at.gte.${twelveHoursAgo}`)
    .order("created_at", { ascending: false })
    .limit(REQUEST_LIMIT);
  if (error) throw error;
  return (data ?? []) as WithdrawalRequestRow[];
}

// ---------------------------------------------------------------------------
// Ref-counted realtime channel — one channel per userId, covering both
// tables, shared across every subscriber for that user.
// ---------------------------------------------------------------------------
type ChannelEntry = { channel: ReturnType<typeof supabase.channel>; refCount: number };
const activeChannels = new Map<string, ChannelEntry>();

function acquireChannel(userId: string, qc: QueryClient) {
  const existing = activeChannels.get(userId);
  if (existing) {
    existing.refCount += 1;
    return;
  }
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: depositRequestsKey(userId) });
    qc.invalidateQueries({ queryKey: withdrawalRequestsKey(userId) });
  };
  const channel = supabase
    .channel(`wallet-requests-${userId}`)
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "deposit_requests", filter: `user_id=eq.${userId}` },
      invalidate,
    )
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "withdrawal_requests", filter: `user_id=eq.${userId}` },
      invalidate,
    )
    .subscribe();
  activeChannels.set(userId, { channel, refCount: 1 });
}

function releaseChannel(userId: string) {
  const entry = activeChannels.get(userId);
  if (!entry) return;
  entry.refCount -= 1;
  if (entry.refCount <= 0) {
    supabase.removeChannel(entry.channel);
    activeChannels.delete(userId);
  }
}

function useRequestsChannel(userId: string | null | undefined) {
  const qc = useQueryClient();
  useEffect(() => {
    if (!userId) return;
    acquireChannel(userId, qc);
    return () => releaseChannel(userId);
  }, [userId, qc]);
}

export function useDepositRequests(userId: string | null | undefined) {
  useRequestsChannel(userId);
  const query = useQuery<DepositRequestRow[]>({
    queryKey: depositRequestsKey(userId),
    enabled: !!userId,
    queryFn: () => fetchDepositRequests(userId as string),
    staleTime: REQUESTS_STALE_MS,
    gcTime: REQUESTS_GC_MS,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  return {
    requests: query.data ?? [],
    isLoading: query.isLoading,
    isFetching: query.isFetching,
    error: query.error,
    refetch: query.refetch,
  };
}

export function useWithdrawalRequestsList(userId: string | null | undefined) {
  useRequestsChannel(userId);
  const query = useQuery<WithdrawalRequestRow[]>({
    queryKey: withdrawalRequestsKey(userId),
    enabled: !!userId,
    queryFn: () => fetchWithdrawalRequests(userId as string),
    staleTime: REQUESTS_STALE_MS,
    gcTime: REQUESTS_GC_MS,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  return {
    requests: query.data ?? [],
    isLoading: query.isLoading,
    isFetching: query.isFetching,
    error: query.error,
    refetch: query.refetch,
  };
}

/** Call after inserting/updating a deposit or withdrawal request to force
 * an immediate refresh instead of waiting for the realtime event. */
export function invalidateWalletRequests(qc: QueryClient, userId: string | null | undefined) {
  if (!userId) return;
  qc.invalidateQueries({ queryKey: depositRequestsKey(userId) });
  qc.invalidateQueries({ queryKey: withdrawalRequestsKey(userId) });
}
