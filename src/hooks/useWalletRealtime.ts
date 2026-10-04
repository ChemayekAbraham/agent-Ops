import { useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

/**
 * Subscribes to wallet-affecting tables (wallets_physical, wallet_deductions, general_ledger)
 * and invalidates the relevant React Query caches so the UI updates instantly when
 * money moves — e.g. when CFO retracts funds or a deposit/withdrawal is approved.
 *
 * Notes:
 * - `wallets` is a view; the physical, publishable table is `wallets_physical`.
 *   Reads still go through `wallets`/`get_user_wallet_view` (strict rule); we only
 *   listen on the physical table for the change stream.
 * - Invalidations are debounced (250ms) so a burst of ledger inserts that also
 *   touches the wallet row collapses into a single refetch — keeps message
 *   handling cheap at 40M-user scale.
 * - On every event we re-call the strict balance RPC via React Query
 *   invalidation. We NEVER read payload.new.* — that would reintroduce the
 *   cache-inflation bug the Withdrawable Strict Rule was built to prevent.
 *
 * Pass a userId to scope the subscription to a single user. Pass undefined to
 * listen platform-wide (useful for ops/CFO dashboards).
 *
 * Ref-counted per channel key (`userId ?? 'global'`), same idiom as
 * useWalletBalance.ts/useWalletRequests.ts: N mounts for the same key share
 * ONE channel. Different callers for the same key can pass different
 * `extraQueryKeys` — those are merged into a live union stored on the
 * shared entry (not snapshotted at channel-creation time), so a caller that
 * joins later still gets its own invalidation targets fired by the
 * already-open channel, and a caller that unmounts doesn't remove another
 * caller's keys from the union while it's still mounted.
 */
type RealtimeChannelEntry = {
  channel: ReturnType<typeof supabase.channel>;
  refCount: number;
  debounceRef: { current: ReturnType<typeof setTimeout> | null };
  // Each mounted caller's extraQueryKeys, keyed by a per-mount instance id
  // so releasing one caller doesn't drop another's keys while it's still
  // mounted for the same channel key.
  extraKeysByInstance: Map<number, string[][]>;
};
const activeRealtimeChannels = new Map<string, RealtimeChannelEntry>();
let instanceCounter = 0;

function acquireRealtimeChannel(
  channelKey: string,
  userId: string | undefined,
  queryClient: ReturnType<typeof useQueryClient>,
  instanceId: number,
  extraQueryKeys: string[][],
) {
  const existing = activeRealtimeChannels.get(channelKey);
  if (existing) {
    existing.refCount += 1;
    existing.extraKeysByInstance.set(instanceId, extraQueryKeys);
    return;
  }

  const debounceRef = { current: null as ReturnType<typeof setTimeout> | null };
  const extraKeysByInstance = new Map<number, string[][]>();
  extraKeysByInstance.set(instanceId, extraQueryKeys);

  const flushInvalidate = () => {
    if (userId) {
      queryClient.invalidateQueries({ queryKey: ['agent-split-balances', userId] });
      queryClient.invalidateQueries({ queryKey: ['wallet', userId] });
    } else {
      queryClient.invalidateQueries({ queryKey: ['agent-split-balances'] });
      queryClient.invalidateQueries({ queryKey: ['wallet'] });
    }
    queryClient.invalidateQueries({ queryKey: ['cfo-wallet-deductions'] });
    // Read live from the map so a caller that joined after channel
    // creation still gets its keys invalidated by this same channel.
    const entry = activeRealtimeChannels.get(channelKey);
    entry?.extraKeysByInstance.forEach((keys) => {
      keys.forEach((k) => queryClient.invalidateQueries({ queryKey: k }));
    });
  };

  const invalidate = () => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(flushInvalidate, 250);
  };

  const walletFilter = userId ? `user_id=eq.${userId}` : undefined;
  const deductionFilter = userId ? `target_user_id=eq.${userId}` : undefined;
  const ledgerFilter = userId ? `user_id=eq.${userId}` : undefined;

  const channel = supabase
    .channel(`wallet-rt-${channelKey}`)
    .on(
      'postgres_changes',
      // wallets is a view; subscribe to the underlying physical table.
      { event: '*', schema: 'public', table: 'wallets_physical', ...(walletFilter ? { filter: walletFilter } : {}) },
      invalidate,
    )
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'wallet_deductions', ...(deductionFilter ? { filter: deductionFilter } : {}) },
      invalidate,
    )
    .on(
      'postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'general_ledger', ...(ledgerFilter ? { filter: ledgerFilter } : {}) },
      invalidate,
    )
    .subscribe();

  activeRealtimeChannels.set(channelKey, { channel, refCount: 1, debounceRef, extraKeysByInstance });
}

function releaseRealtimeChannel(channelKey: string, instanceId: number) {
  const entry = activeRealtimeChannels.get(channelKey);
  if (!entry) return;
  entry.extraKeysByInstance.delete(instanceId);
  entry.refCount -= 1;
  if (entry.refCount <= 0) {
    if (entry.debounceRef.current) clearTimeout(entry.debounceRef.current);
    supabase.removeChannel(entry.channel);
    activeRealtimeChannels.delete(channelKey);
  }
}

export function useWalletRealtime(userId?: string, extraQueryKeys: string[][] = []) {
  const queryClient = useQueryClient();
  const instanceIdRef = useRef<number | null>(null);
  if (instanceIdRef.current === null) instanceIdRef.current = ++instanceCounter;

  useEffect(() => {
    const channelKey = userId ?? 'global';
    const instanceId = instanceIdRef.current as number;
    acquireRealtimeChannel(channelKey, userId, queryClient, instanceId, extraQueryKeys);
    return () => releaseRealtimeChannel(channelKey, instanceId);
    // extraQueryKeys is intentionally not a dep — callers pass a fresh
    // array literal each render; re-running this effect per-render would
    // thrash the channel. The instance's entry in extraKeysByInstance is
    // set once on acquire and read live by flushInvalidate on every event,
    // which is enough for the current fixed-per-mount usage.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId, queryClient]);
}