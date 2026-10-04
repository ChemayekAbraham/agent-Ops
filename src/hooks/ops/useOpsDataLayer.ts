/**
 * Shared Operations Data Layer hooks.
 *
 * Every ops screen (CFO, Finance, COO, Merchant Ops, Withdrawals,
 * Rent Approvals, Wallet Management, User Search) should consume these
 * hooks instead of querying `profiles` / `wallets` / `user_roles` /
 * `landlords` directly. They wrap the optimized `ops_*` RPCs which
 * batch lookups, apply keyset pagination, and are SECURITY DEFINER so
 * they bypass per-row RLS overhead.
 *
 * See: migration "Phase 1: Shared Operations Data Layer".
 */
import { useEffect } from "react";
import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type OpsProfileLite = {
  id: string;
  full_name: string | null;
  phone: string | null;
  email: string | null;
  avatar_url: string | null;
  verified: boolean | null;
  tenant_status: string | null;
  created_at: string;
};

export type OpsWalletBuckets = {
  user_id: string;
  balance: number;
  withdrawable_balance: number;
  float_balance: number;
  advance_balance: number;
  locked_balance: number;
};

export type OpsLandlord = {
  id: string;
  name: string;
  phone: string | null;
  district: string | null;
  town_council: string | null;
  house_category: string | null;
  monthly_rent: number | null;
  verified: boolean;
  created_at: string;
  agent_id: string | null;
  tenant_id: string | null;
};

export type OpsSearchProfileEnriched = OpsProfileLite & {
  balance: number | null;
  withdrawable_balance: number | null;
  float_balance: number | null;
  advance_balance: number | null;
  primary_role: string | null;
};

export type OpsLedgerRow = {
  id: string;
  amount: number;
  direction: string;
  category: string | null;
  description: string | null;
  created_at: string;
  wallet_bucket: string | null;
};

export type OpsDailySummary = {
  refreshed_at: string;
  withdrawals_pending_count: number;
  withdrawals_pending_ugx: number;
  withdrawals_today_count: number;
  withdrawals_today_ugx: number;
  deposits_today_count: number;
  deposits_today_ugx: number;
  total_users: number;
  users_today: number;
  active_24h: number;
  landlords_verified: number;
  listings_available: number;
};

// ---------------------------------------------------------------------------
// Standard query defaults for ops screens.
// Import as: { ...OPS_QUERY_DEFAULTS }
// ---------------------------------------------------------------------------

export const OPS_QUERY_DEFAULTS = {
  staleTime: 30_000,
  gcTime: 5 * 60_000,
  refetchOnWindowFocus: false,
  retry: 1,
} as const;

// ---------------------------------------------------------------------------
// 0. Canonical single-user wallet hook — the ONE hook every screen should use
//    when it needs a single wallet's authoritative balances.
//
//    Backed by `get_authoritative_wallet(user_id)` (v_user_wallet_strict).
//    Shared query key + shared stale time → React Query deduplicates every
//    caller into a single network round-trip per user per 8s window.
// ---------------------------------------------------------------------------

export type OpsWallet = {
  userId: string;
  withdrawable: number;
  float: number;
  advance: number;
  pendingHolds: number;
  cache: { withdrawable: number; float: number; advance: number };
  drift: { withdrawable: number; float: number; advance: number };
};

export const opsWalletKey = (userId: string | null | undefined) =>
  ["ops", "wallet", userId ?? ""] as const;

export async function fetchOpsWallet(userId: string): Promise<OpsWallet | null> {
  if (!userId) return null;
  const { data, error } = await supabase.rpc("get_authoritative_wallet", { p_user_id: userId });
  if (error) throw error;
  const d: any = data ?? {};
  return {
    userId,
    withdrawable: Number(d.withdrawable) || 0,
    float: Number(d.float) || 0,
    advance: Number(d.advance) || 0,
    pendingHolds: Number(d.pending_holds) || 0,
    cache: {
      withdrawable: Number(d.cache?.withdrawable) || 0,
      float: Number(d.cache?.float) || 0,
      advance: Number(d.cache?.advance) || 0,
    },
    drift: {
      withdrawable: Number(d.drift?.withdrawable) || 0,
      float: Number(d.drift?.float) || 0,
      advance: Number(d.drift?.advance) || 0,
    },
  };
}

/**
 * `useOpsWallet(userId)` — canonical single-user wallet hook.
 *
 * • Shared query key `['ops','wallet', userId]` so all subscribers dedupe.
 * • 8s stale time (within the 5–10s target for ops screens).
 * • Optional realtime refetch on new ledger rows for this user.
 * • Call `invalidateOpsWallet(qc, userId)` after any financial mutation.
 */
export function useOpsWallet(
  userId: string | null | undefined,
  opts: { realtime?: boolean } = { realtime: true },
) {
  const qc = useQueryClient();
  const query = useQuery({
    queryKey: opsWalletKey(userId),
    enabled: !!userId,
    staleTime: 8_000,
    gcTime: 5 * 60_000,
    refetchOnWindowFocus: false,
    queryFn: () => fetchOpsWallet(userId as string),
  });

  useEffect(() => {
    if (!userId || !opts.realtime) return;
    const channel = supabase
      .channel(`ops-wallet-${userId}`)
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "general_ledger", filter: `user_id=eq.${userId}` },
        () => {
          qc.invalidateQueries({ queryKey: opsWalletKey(userId) });
        },
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [userId, opts.realtime, qc]);

  return query;
}

/**
 * Invalidate a user's authoritative wallet cache after a successful financial
 * mutation (deposit, withdrawal approval, ledger post, transfer, top-up).
 * Call this from every mutation's onSuccess.
 */
export function invalidateOpsWallet(qc: QueryClient, userId: string | null | undefined) {
  if (!userId) return;
  qc.invalidateQueries({ queryKey: opsWalletKey(userId) });
  // Also nudge the batch-buckets hook so lists re-hydrate.
  qc.invalidateQueries({ queryKey: ["ops", "wallet-buckets"] });
}

// ---------------------------------------------------------------------------
// 1. Batch profile lookup — replaces `profiles where id = ANY(...)` N+1
// ---------------------------------------------------------------------------

export async function fetchOpsProfilesLite(ids: string[]): Promise<OpsProfileLite[]> {
  const unique = Array.from(new Set(ids.filter(Boolean)));
  if (unique.length === 0) return [];
  const { data, error } = await supabase.rpc("ops_get_profiles_lite", { p_ids: unique });
  if (error) throw error;
  return (data ?? []) as OpsProfileLite[];
}

export function useOpsProfilesLite(ids: string[]) {
  const unique = Array.from(new Set(ids.filter(Boolean))).sort();
  return useQuery({
    queryKey: ["ops", "profiles-lite", unique],
    queryFn: () => fetchOpsProfilesLite(unique),
    enabled: unique.length > 0,
    ...OPS_QUERY_DEFAULTS,
  });
}

// ---------------------------------------------------------------------------
// 2. Batch wallet buckets — replaces `wallets where user_id = ANY(...)`
// ---------------------------------------------------------------------------

export async function fetchOpsWalletBuckets(ids: string[]): Promise<OpsWalletBuckets[]> {
  const unique = Array.from(new Set(ids.filter(Boolean)));
  if (unique.length === 0) return [];
  const { data, error } = await supabase.rpc("ops_get_wallet_buckets", { p_ids: unique });
  if (error) throw error;
  return (data ?? []) as OpsWalletBuckets[];
}

export function useOpsWalletBuckets(ids: string[]) {
  const unique = Array.from(new Set(ids.filter(Boolean))).sort();
  return useQuery({
    queryKey: ["ops", "wallet-buckets", unique],
    queryFn: () => fetchOpsWalletBuckets(unique),
    enabled: unique.length > 0,
    ...OPS_QUERY_DEFAULTS,
  });
}

// ---------------------------------------------------------------------------
// 3. Landlord search — trigram + keyset paginated
// ---------------------------------------------------------------------------

export type OpsLandlordSearchArgs = {
  query?: string;
  verifiedOnly?: boolean;
  limit?: number;
  cursorName?: string | null;
  cursorId?: string | null;
};

export async function fetchOpsLandlords(args: OpsLandlordSearchArgs): Promise<OpsLandlord[]> {
  const { data, error } = await supabase.rpc("ops_search_landlords", {
    p_query: args.query ?? null,
    p_verified_only: args.verifiedOnly ?? true,
    p_limit: args.limit ?? 50,
    p_cursor_name: args.cursorName ?? null,
    p_cursor_id: args.cursorId ?? null,
  });
  if (error) throw error;
  return (data ?? []) as OpsLandlord[];
}

export function useOpsLandlords(args: OpsLandlordSearchArgs) {
  return useQuery({
    queryKey: ["ops", "landlords", args],
    queryFn: () => fetchOpsLandlords(args),
    ...OPS_QUERY_DEFAULTS,
  });
}

// ---------------------------------------------------------------------------
// 4. Enriched profile search — one round-trip for User/Wallet Owner Search
// ---------------------------------------------------------------------------

export async function searchOpsProfilesEnriched(query: string, limit = 20): Promise<OpsSearchProfileEnriched[]> {
  const q = (query ?? "").trim();
  if (q.length < 2) return [];
  const { data, error } = await supabase.rpc("ops_search_profiles_enriched", {
    p_query: q,
    p_limit: limit,
  });
  if (error) throw error;
  return (data ?? []) as OpsSearchProfileEnriched[];
}

export function useOpsSearchProfiles(query: string, limit = 20) {
  const q = (query ?? "").trim();
  return useQuery({
    queryKey: ["ops", "search-profiles", q, limit],
    queryFn: () => searchOpsProfilesEnriched(q, limit),
    enabled: q.length >= 2,
    ...OPS_QUERY_DEFAULTS,
  });
}

// ---------------------------------------------------------------------------
// 5. Keyset-paginated ledger page — Wallet Statement / ledger drawers
// ---------------------------------------------------------------------------

export type OpsLedgerPageArgs = {
  userId: string;
  limit?: number;
  cursorCreatedAt?: string | null;
  cursorId?: string | null;
};

export async function fetchOpsLedgerPage(args: OpsLedgerPageArgs): Promise<OpsLedgerRow[]> {
  if (!args.userId) return [];
  const { data, error } = await supabase.rpc("ops_get_ledger_page", {
    p_user_id: args.userId,
    p_limit: args.limit ?? 50,
    p_cursor_created_at: args.cursorCreatedAt ?? null,
    p_cursor_id: args.cursorId ?? null,
  });
  if (error) throw error;
  return (data ?? []) as OpsLedgerRow[];
}

export function useOpsLedgerPage(args: OpsLedgerPageArgs) {
  return useQuery({
    queryKey: ["ops", "ledger-page", args],
    queryFn: () => fetchOpsLedgerPage(args),
    enabled: Boolean(args.userId),
    ...OPS_QUERY_DEFAULTS,
  });
}

// ---------------------------------------------------------------------------
// 6. Daily ops KPIs — reads from a 5-min-refreshed materialized view
// ---------------------------------------------------------------------------

export async function fetchOpsDailySummary(): Promise<OpsDailySummary | null> {
  const { data, error } = await supabase.rpc("ops_get_daily_summary");
  if (error) throw error;
  const row = Array.isArray(data) ? data[0] : data;
  return (row ?? null) as OpsDailySummary | null;
}

export function useOpsDailySummary() {
  return useQuery({
    queryKey: ["ops", "daily-summary"],
    queryFn: fetchOpsDailySummary,
    staleTime: 60_000,
    gcTime: 5 * 60_000,
    refetchOnWindowFocus: false,
  });
}

// ---------------------------------------------------------------------------
// 7. Lightweight perf tracker — feeds ops_perf_metrics
// ---------------------------------------------------------------------------

export async function recordOpsMetric(screen: string, action: string, durationMs: number, rows?: number) {
  try {
    await supabase.from("ops_perf_metrics").insert({
      screen,
      action,
      duration_ms: Math.max(0, Math.round(durationMs)),
      rows_returned: rows ?? null,
    });
  } catch {
    // best-effort; never surface metric errors to the user
  }
}

export function trackOpsQuery<T>(screen: string, action: string, fn: () => Promise<T>): Promise<T> {
  const t0 = performance.now();
  return fn().then(
    (result) => {
      const rows = Array.isArray(result) ? result.length : undefined;
      void recordOpsMetric(screen, action, performance.now() - t0, rows);
      return result;
    },
    (err) => {
      void recordOpsMetric(screen, `${action}:error`, performance.now() - t0);
      throw err;
    },
  );
}