/**
 * useWalletBalance — CANONICAL wallet hook.
 *
 * Every component that displays a wallet balance (card, hero, dialog,
 * statement, drawer, statistics) MUST use this hook. It reads
 * `get_user_wallet_view` (strict, ledger-derived — the same source the
 * ledger statement uses), so the wallet card and the ledger can never
 * show different numbers.
 *
 * The hook keeps a very short in-memory cache so wallet cards, dialogs,
 * sheets, and statements on the same screen do not refetch in a render loop.
 * Mutations and realtime events still invalidate immediately, so the visible
 * balance remains live without polling.
 *
 *   staleTime: 8s   — shared subscribers reuse one recent wallet read
 *   gcTime: 5m      — avoids remount storms while navigating wallet dialogs
 *   refetchOnWindowFocus: false   — money reads never fire on tab focus
 *   refetchOnReconnect: false     — realtime handles freshness after reconnect
 *   refetchInterval: undefined    — no polling; realtime pushes invalidations
 *
 * Realtime channels (wallets_physical / general_ledger / withdrawal_requests
 * / wallet_transactions for the user) are ref-counted per userId so N
 * subscribers on the same page share ONE channel.
 */
import { useEffect } from "react";
import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { trackRequest } from "@/lib/costMonitor";
import { applyCustomerWalletLedgerFilters, isCustomerWalletLedgerEntryVisible } from "@/lib/customerWalletHistory";

export interface WalletBalanceView {
  userId: string;
  /** Withdrawable (transferable) balance, strict from ledger, holds subtracted. */
  withdrawable: number;
  /** Operational float — company money, never transferable/withdrawable. */
  floatBalance: number;
  /** Liability owed back to platform. Not spendable. */
  advanceBalance: number;
  /** In-flight withdrawal holds already subtracted from `withdrawable`. */
  pendingHolds: number;
  /** Restricted / held funds surfaced from the RPC. */
  restrictedHeld: number;
  /** Convenience total (withdrawable + float) — matches legacy `wallet.balance`. */
  totalVisible: number;
  updatedAt: string | null;
}

export const walletBalanceKey = (userId: string | null | undefined) =>
  ["wallet-view", userId ?? ""] as const;

/** Query key for the latest 10 wallet transactions preview. */
export const walletRecentTxKey = (userId: string | null | undefined) =>
  ["wallet-recent-tx", userId ?? ""] as const;

const WALLET_VIEW_STALE_MS = 8_000;
const WALLET_VIEW_GC_MS = 5 * 60_000;

/** Canonical shape of a wallet transaction row (ledger-derived). */
export interface WalletTxRow {
  id: string;
  transaction_date: string;
  amount: number;
  direction: "cash_in" | "cash_out";
  category: string;
  description: string | null;
  reference_id: string | null;
  linked_party: string | null;
  source_table: string | null;
  classification?: string | null;
  source_id?: string | null;
}

/** How many recent transactions ship with the balance preview. */
export const WALLET_RECENT_TX_LIMIT = 10;

/**
 * Base user-facing ledger query — mirrors the "user-facing ledger filter"
 * rule (hide finance-only corrections/reconciliations/backfills; wallet + bridge
 * scopes only). Reused by both the preview hook and the paginated hook so
 * the numbers never diverge.
 */
function baseUserLedgerQuery(userId: string) {
  const query = supabase
    .from("general_ledger")
    .select(
      "id, transaction_date, amount, direction, category, description, reference_id, linked_party, source_table, source_id, classification",
    )
    .eq("user_id", userId)
    .in("ledger_scope", ["wallet", "bridge"]);

  return applyCustomerWalletLedgerFilters(query);
}

export async function fetchRecentWalletTransactions(
  userId: string,
  limit = WALLET_RECENT_TX_LIMIT,
): Promise<WalletTxRow[]> {
  trackRequest("db", "wallet_recent_transactions");
  const { data, error } = await baseUserLedgerQuery(userId)
    .order("transaction_date", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return ((data ?? []) as WalletTxRow[]).filter(isCustomerWalletLedgerEntryVisible);
}

/**
 * Shared pagination fetcher — used by `useWalletTransactions`.
 *
 * NOTE: we deliberately do NOT ask PostgREST for an exact count. An exact
 * count forces the whole filtered set (RLS visibility function included) to
 * be scanned on every page load, which was hitting the 8s statement timeout
 * on a busy database and surfacing as "Couldn't load your wallet statement".
 * Instead we over-fetch a single extra row to know whether a next page exists.
 */
export async function fetchWalletTransactionsPage(
  userId: string,
  opts: { page: number; pageSize: number; direction?: "all" | "in" | "out" },
): Promise<{ rows: WalletTxRow[]; total: number; hasMore: boolean }> {
  trackRequest("db", "wallet_transactions_page");
  const from = opts.page * opts.pageSize;
  // One extra row acts as the "is there a next page?" probe.
  const to = from + opts.pageSize;
  let q = baseUserLedgerQuery(userId).order("transaction_date", { ascending: false });
  if (opts.direction === "in") q = q.eq("direction", "cash_in");
  if (opts.direction === "out") q = q.eq("direction", "cash_out");
  const { data, error } = await q.range(from, to);
  if (error) throw error;
  const fetched = (data ?? []) as WalletTxRow[];
  const hasMore = fetched.length > opts.pageSize;
  const rows = fetched.slice(0, opts.pageSize).filter(isCustomerWalletLedgerEntryVisible);
  // `total` is a floor, not an exact count: enough for page math, cheap to get.
  return { rows, total: from + rows.length + (hasMore ? 1 : 0), hasMore };
}

/** Called by every wallet mutation to invalidate BOTH balance and preview. */
export function invalidateWalletBalance(qc: QueryClient, userId: string | null | undefined) {
  if (!userId) return;
  qc.invalidateQueries({ queryKey: walletBalanceKey(userId) });
  qc.invalidateQueries({ queryKey: walletRecentTxKey(userId) });
  qc.invalidateQueries({ queryKey: ["wallet-tx-page", userId] });
}

const EMPTY: Omit<WalletBalanceView, "userId"> = {
  withdrawable: 0,
  floatBalance: 0,
  advanceBalance: 0,
  pendingHolds: 0,
  restrictedHeld: 0,
  totalVisible: 0,
  updatedAt: null,
};

export async function fetchWalletBalance(userId: string): Promise<WalletBalanceView> {
  trackRequest("db", "get_user_wallet_view");
  const { data, error } = await supabase.rpc("get_user_wallet_view", { p_user_id: userId });
  if (error) throw error;
  const d = (data ?? {}) as Record<string, unknown>;
  const withdrawable = Number((d.withdrawable as number | string | undefined) ?? 0);
  const floatBalance = Number((d.float_balance as number | string | undefined) ?? 0);
  const advanceBalance = Number((d.advance_balance as number | string | undefined) ?? 0);
  const pendingHolds = Number((d.pending_holds as number | string | undefined) ?? 0);
  const restrictedHeld = Number((d.restricted_held as number | string | undefined) ?? 0);
  const totalVisibleFromRpc = Number((d.total_visible as number | string | undefined) ?? NaN);
  return {
    userId,
    withdrawable,
    floatBalance,
    advanceBalance,
    pendingHolds,
    restrictedHeld,
    totalVisible: Number.isFinite(totalVisibleFromRpc)
      ? totalVisibleFromRpc
      : withdrawable + floatBalance,
    updatedAt: (d.updated_at as string | undefined) ?? null,
  };
}

// ---------------------------------------------------------------------------
// Ref-counted realtime channels — one channel per userId, shared across
// every hook subscriber for that user.
// ---------------------------------------------------------------------------

type ChannelEntry = {
  channel: ReturnType<typeof supabase.channel>;
  refCount: number;
};
const activeChannels = new Map<string, ChannelEntry>();

function acquireChannel(userId: string, qc: QueryClient) {
  const existing = activeChannels.get(userId);
  if (existing) {
    existing.refCount += 1;
    return;
  }
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: walletBalanceKey(userId) });
    qc.invalidateQueries({ queryKey: walletRecentTxKey(userId) });
    qc.invalidateQueries({ queryKey: ["wallet-tx-page", userId] });
  };
  const channel = supabase
    .channel(`wallet-view-${userId}`)
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "wallets_physical", filter: `user_id=eq.${userId}` },
      invalidate,
    )
    .on(
      "postgres_changes",
      { event: "INSERT", schema: "public", table: "general_ledger", filter: `user_id=eq.${userId}` },
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

/**
 * Read the strict wallet view for `userId`.
 *
 * Every subscriber on the same page/tick dedupes into ONE round-trip.
 * No cross-session cache. Realtime keeps balances fresh; mutations should
 * additionally call `invalidateWalletBalance(qc, userId)` on success.
 */
export function useWalletBalance(userId: string | null | undefined) {
  const qc = useQueryClient();

  const query = useQuery<WalletBalanceView>({
    queryKey: walletBalanceKey(userId),
    enabled: !!userId,
    queryFn: () => fetchWalletBalance(userId as string),
    staleTime: WALLET_VIEW_STALE_MS,
    gcTime: WALLET_VIEW_GC_MS,
    refetchOnMount: true,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    retry: 1,
  });

  // Latest 10 transactions ship alongside the balance. Same realtime channel
  // invalidates both queries so wallet cards on every dashboard (tenant /
  // agent / funder / landlord) render balance + recent activity from one
  // canonical source with one round-trip apiece.
  const recent = useQuery<WalletTxRow[]>({
    queryKey: walletRecentTxKey(userId),
    enabled: !!userId,
    queryFn: () => fetchRecentWalletTransactions(userId as string),
    staleTime: WALLET_VIEW_STALE_MS,
    gcTime: WALLET_VIEW_GC_MS,
    refetchOnMount: true,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    retry: 1,
  });

  useEffect(() => {
    if (!userId) return;
    acquireChannel(userId, qc);
    return () => releaseChannel(userId);
  }, [userId, qc]);

  const value: WalletBalanceView = query.data ?? { userId: userId ?? "", ...EMPTY };
  return {
    ...value,
    isLoading: query.isLoading,
    isFetching: query.isFetching,
    error: query.error,
    refetch: query.refetch,
    /** Latest 10 wallet transactions (user-facing filter applied). */
    recentTransactions: recent.data ?? [],
    recentTransactionsLoading: recent.isLoading,
    refetchRecentTransactions: recent.refetch,
  };
}