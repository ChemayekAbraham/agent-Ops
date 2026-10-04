/**
 * useWithdrawContext — UNIFIED withdrawal source of truth.
 *
 * Collapses 4 pre-submit reads (get_user_wallet_view + get_kyc_effective_limits +
 * today's withdrawal_requests aggregation + treasury_controls paused flag)
 * into ONE server RPC (`get_withdraw_context`), plus one realtime channel.
 *
 * Also exposes:
 *   - server-computed `gates.canSubmit` + `gates.blockReason` so the
 *     submit-side trigger and the UI can't disagree.
 *   - `checkAmount(n)` — pure client helper that layers the per-amount
 *     checks (min, > withdrawable, > remainingToday) on top of the gates.
 *   - `savedMethods` — passthrough of the existing useSavedPayoutMethods.
 *
 * All withdrawal dialogs should consume this hook so a gate added here
 * (new AML rule, region freeze, etc.) is enforced everywhere at once.
 */
import { useEffect } from 'react';
import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { useSavedPayoutMethods } from '@/hooks/useSavedPayoutMethods';

export interface WithdrawContextWallet {
  withdrawable: number;
  floatBalance: number;
  advanceBalance: number;
  pendingHolds: number;
  restrictedHeld: number;
  totalVisible: number;
}

export interface WithdrawContextKyc {
  level: number;
  frozen: boolean;
  dailyCapUgx: number;
  dailyCountCap: number;
  maxSingleTransferUgx: number;
}

export interface WithdrawContextUsageToday {
  amount: number;
  count: number;
  remainingAmount: number;
  remainingCount: number;
}

export interface WithdrawContextGates {
  withdrawalsPaused: boolean;
  frozen: boolean;
  canSubmit: boolean;
  blockReason: string | null;
}

export interface WithdrawContext {
  wallet: WithdrawContextWallet;
  kyc: WithdrawContextKyc;
  usageToday: WithdrawContextUsageToday;
  gates: WithdrawContextGates;
  generatedAt: string | null;
}

const EMPTY: WithdrawContext = {
  wallet: {
    withdrawable: 0,
    floatBalance: 0,
    advanceBalance: 0,
    pendingHolds: 0,
    restrictedHeld: 0,
    totalVisible: 0,
  },
  kyc: {
    level: 1,
    frozen: false,
    dailyCapUgx: 0,
    dailyCountCap: 0,
    maxSingleTransferUgx: 0,
  },
  usageToday: { amount: 0, count: 0, remainingAmount: 0, remainingCount: 0 },
  gates: { withdrawalsPaused: false, frozen: false, canSubmit: false, blockReason: 'Loading…' },
  generatedAt: null,
};

export const withdrawContextKey = (userId: string | null | undefined) =>
  ['withdraw-context', userId ?? ''] as const;

/** Fallback used when the context RPC fails — never claims "Loading…". */
const ERRORED: WithdrawContext = {
  ...EMPTY,
  gates: {
    ...EMPTY.gates,
    blockReason: "We couldn't check your withdrawal limits. Please try again.",
  },
};

type Num = number | string | null | undefined;
const n = (v: Num) => Number(v ?? 0);

async function fetchWithdrawContext(userId: string): Promise<WithdrawContext> {
  const { data, error } = await supabase.rpc('get_withdraw_context' as never, {
    p_user_id: userId,
  } as never);
  if (error) throw error;
  const d = (data ?? {}) as Record<string, unknown>;
  const w = (d.wallet ?? {}) as Record<string, Num>;
  const k = (d.kyc ?? {}) as Record<string, unknown>;
  const u = (d.usage_today ?? {}) as Record<string, Num>;
  const g = (d.gates ?? {}) as Record<string, unknown>;
  return {
    wallet: {
      withdrawable: n(w.withdrawable as Num),
      floatBalance: n(w.float_balance as Num),
      advanceBalance: n(w.advance_balance as Num),
      pendingHolds: n(w.pending_holds as Num),
      restrictedHeld: n(w.restricted_held as Num),
      totalVisible: n(w.total_visible as Num),
    },
    kyc: {
      level: Number((k.level as Num) ?? 1),
      frozen: Boolean(k.frozen),
      dailyCapUgx: n(k.daily_cap_ugx as Num),
      dailyCountCap: Number((k.daily_count_cap as Num) ?? 0),
      maxSingleTransferUgx: n(k.max_single_transfer_ugx as Num),
    },
    usageToday: {
      amount: n(u.amount),
      count: Number((u.count as Num) ?? 0),
      remainingAmount: n(u.remaining_amount),
      remainingCount: Number((u.remaining_count as Num) ?? 0),
    },
    gates: {
      withdrawalsPaused: Boolean(g.withdrawals_paused),
      frozen: Boolean(g.frozen),
      canSubmit: Boolean(g.can_submit),
      blockReason: (g.block_reason as string | null) ?? null,
    },
    generatedAt: (d.generated_at as string | null) ?? null,
  };
}

// Matches useWalletBalance's convention. gcTime was previously 0 (cache
// dropped the instant the last subscriber unmounted) + refetchOnMount:
// 'always' — meaning every dialog open was a guaranteed cold RPC round
// trip plus a channel teardown/resubscribe, even for a re-open seconds
// later. That's the felt "lag when opening Withdraw". Correctness is
// preserved by the forced refetch()+recheck immediately before submit
// (see WithdrawRequestDialog.tsx) — the longer-lived cache only affects
// what's shown while the dialog is open, never what's trusted at submit.
const WITHDRAW_CONTEXT_GC_MS = 5 * 60_000;

// Ref-counted realtime channel — one per user, shared across subscribers.
type ChannelEntry = { channel: ReturnType<typeof supabase.channel>; refCount: number };
const activeChannels = new Map<string, ChannelEntry>();

function acquireChannel(userId: string, qc: QueryClient) {
  const existing = activeChannels.get(userId);
  if (existing) { existing.refCount += 1; return; }
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: withdrawContextKey(userId) });
  };
  const channel = supabase
    .channel(`withdraw-ctx-${userId}`)
    .on('postgres_changes', {
      event: '*', schema: 'public', table: 'withdrawal_requests', filter: `user_id=eq.${userId}`,
    }, invalidate)
    .on('postgres_changes', {
      event: '*', schema: 'public', table: 'wallet_balances_projection', filter: `user_id=eq.${userId}`,
    }, invalidate)
    // No treasury_controls listener: that table is not in the Realtime
    // publication, so it never fired (doc 147). gates.withdrawalsPaused is
    // still re-checked by the forced refetch right before submit.
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

export interface AmountCheck {
  ok: boolean;
  reason?: string;
  cappedAt?: number;
}

export function useWithdrawContext(userIdOverride?: string) {
  const { user } = useAuth();
  const userId = userIdOverride ?? user?.id ?? null;
  const qc = useQueryClient();

  const query = useQuery<WithdrawContext>({
    queryKey: withdrawContextKey(userId),
    enabled: !!userId,
    queryFn: () => fetchWithdrawContext(userId as string),
    staleTime: 15_000,
    gcTime: WITHDRAW_CONTEXT_GC_MS,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });

  useEffect(() => {
    if (!userId) return;
    acquireChannel(userId, qc);
    return () => releaseChannel(userId);
  }, [userId, qc]);

  const ctx = query.data ?? (query.isError ? ERRORED : EMPTY);

  const savedMethods = useSavedPayoutMethods();

  /**
   * Layer per-amount checks on top of the server gate. Order matters: the
   * server gate is checked FIRST so a paused platform or frozen account always wins.
   * Daily withdrawal limits have been removed globally; only available balance gates here.
   */
  const checkAmount = (amount: number, opts?: { min?: number }): AmountCheck => {
    if (query.isLoading) return { ok: false, reason: 'Checking limits…' };
    if (query.isError) return { ok: false, reason: ERRORED.gates.blockReason as string };
    if (!ctx.gates.canSubmit) return { ok: false, reason: ctx.gates.blockReason ?? 'Blocked' };
    const min = opts?.min ?? 500;
    if (!(amount > 0)) return { ok: false, reason: 'Enter an amount' };
    if (amount < min) return { ok: false, reason: `Minimum is UGX ${min.toLocaleString()}` };
    if (amount > ctx.wallet.withdrawable) {
      return {
        ok: false,
        reason: `Exceeds available balance (UGX ${ctx.wallet.withdrawable.toLocaleString()}).`,
        cappedAt: ctx.wallet.withdrawable,
      };
    }
    return { ok: true };
  };

  return {
    ...ctx,
    isLoading: query.isLoading,
    isFetching: query.isFetching,
    error: query.error,
    refetch: query.refetch,
    checkAmount,
    savedMethods,
  };
}

/** Call after a successful withdrawal insert to force-refresh the context. */
export function invalidateWithdrawContext(qc: QueryClient, userId: string | null | undefined) {
  if (!userId) return;
  qc.invalidateQueries({ queryKey: withdrawContextKey(userId) });
}