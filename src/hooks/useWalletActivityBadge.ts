import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { applyCustomerWalletLedgerFilters } from '@/lib/customerWalletHistory';

/**
 * Tracks new wallet activity (general_ledger wallet-scope entries) since the
 * user last viewed their Wallet Statement. Powers the pulsing badge on the
 * Statement trigger button.
 */
const storageKey = (userId: string) => `welile-wallet-statement-last-seen:${userId}`;

// Realtime can miss events across a dropped/backgrounded socket (mobile
// tab sleep). A time-based poll defended against that but ran constantly
// even while the socket was healthy. This mirrors useUserSnapshot's
// pattern instead: only catch up when the tab becomes visible again AND
// enough time has passed that a missed event is plausible.
const STALE_AFTER_MS = 30_000;

export function useWalletActivityBadge(userId: string | undefined) {
  const [count, setCount] = useState(0);
  const [latestAt, setLatestAt] = useState<string | null>(null);
  const lastFetchedRef = useRef<number | null>(null);

  const getLastSeen = useCallback(() => {
    if (!userId) return null;
    try {
      return localStorage.getItem(storageKey(userId));
    } catch {
      return null;
    }
  }, [userId]);

  const refresh = useCallback(async () => {
    if (!userId) return;
    const lastSeen = getLastSeen();

    let query = applyCustomerWalletLedgerFilters(supabase
      .from('general_ledger')
      .select('transaction_date', { count: 'exact', head: false })
      .eq('user_id', userId)
      .eq('ledger_scope', 'wallet'))
      .order('transaction_date', { ascending: false })
      .limit(1);

    // Also grab count > lastSeen
    let countQuery = applyCustomerWalletLedgerFilters(supabase
      .from('general_ledger')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId)
      .eq('ledger_scope', 'wallet'));

    if (lastSeen) {
      countQuery = countQuery.gt('transaction_date', lastSeen);
    }

    const [latestRes, countRes] = await Promise.all([query, countQuery]);
    lastFetchedRef.current = Date.now();
    const latest = latestRes.data?.[0]?.transaction_date ?? null;
    setLatestAt(latest);
    if (!lastSeen) {
      // First visit ever — treat existing history as already seen; don't
      // spam the badge with hundreds of historical entries.
      if (latest) {
        try { localStorage.setItem(storageKey(userId), latest); } catch {}
      }
      setCount(0);
      return;
    }
    setCount(countRes.count ?? 0);
  }, [userId, getLastSeen]);

  const markSeen = useCallback(() => {
    if (!userId) return;
    const stamp = latestAt || new Date().toISOString();
    try { localStorage.setItem(storageKey(userId), stamp); } catch {}
    setCount(0);
  }, [userId, latestAt]);

  useEffect(() => {
    if (!userId) return;
    void refresh();

    const channel = supabase
      .channel(`wallet-activity-badge-${userId}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'general_ledger', filter: `user_id=eq.${userId}` },
        () => { void refresh(); }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [userId, refresh]);

  // Catch up if the tab was backgrounded long enough that a realtime event
  // could plausibly have been missed (socket drop/reconnect). Not a poll —
  // only fires on an actual visibility/focus transition.
  useEffect(() => {
    if (!userId) return;
    const onFocus = () => {
      if (document.visibilityState !== 'visible') return;
      if (!lastFetchedRef.current) return;
      if (Date.now() - lastFetchedRef.current > STALE_AFTER_MS) {
        void refresh();
      }
    };
    document.addEventListener('visibilitychange', onFocus);
    window.addEventListener('focus', onFocus);
    return () => {
      document.removeEventListener('visibilitychange', onFocus);
      window.removeEventListener('focus', onFocus);
    };
  }, [userId, refresh]);

  return { count, markSeen, refresh };
}