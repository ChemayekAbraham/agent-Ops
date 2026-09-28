import { useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { usePolling } from '@/hooks/usePolling';

/**
 * Reads the CTO Platform Controls flag `proxy_payout_priority` from
 * `treasury_controls`.
 *
 * ON  (default) → Proxy Agent withdrawals are Priority #1: they sit at the top
 *                 of the Merchant Agent Payout Queue and NO other payout may be
 *                 claimed while one is unclaimed.
 * OFF           → the hold is released; merchant agents work normal customer
 *                 withdrawals in the usual order.
 *
 * The database is still the enforcing authority
 * (`assert_no_urgent_proxy_priority` reads the same row); this hook keeps the UI
 * identical to what the server will allow. Polled (60s + on focus):
 * treasury_controls is not in the Realtime publication, so the old listener
 * never fired (doc 147).
 */
export function useProxyPayoutPriority(): {
  enforced: boolean;
  loading: boolean;
  lastUpdatedAt: Date | null;
  refresh: () => Promise<void>;
} {
  const [enforced, setEnforced] = useState(true);
  const [loading, setLoading] = useState(true);

  const { lastUpdatedAt, refresh } = usePolling(async () => {
    const { data } = await supabase
      .from('treasury_controls')
      .select('enabled')
      .eq('control_key', 'proxy_payout_priority')
      .maybeSingle();
    // Default to enforced when the row is unreadable/missing (fail safe).
    setEnforced(data ? !!data.enabled : true);
    setLoading(false);
  }, 60_000, { immediate: true });

  return { enforced, loading, lastUpdatedAt, refresh };
}

export default useProxyPayoutPriority;
