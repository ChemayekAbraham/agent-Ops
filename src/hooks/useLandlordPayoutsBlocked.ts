import { useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { usePolling } from '@/hooks/usePolling';

/**
 * Reads the CTO Platform Controls flag `landlord_payouts_blocked` from
 * `treasury_controls`.
 *
 * ON  -> Landlord float payouts are hidden from the Merchant Agent Payout
 *        Queue and cannot be claimed (server-side: v_merchant_payout_queue,
 *        claim_withdrawal_verified, get_withdrawal_claim_status all enforce
 *        this too — this hook only drives what the queue UI fetches/shows).
 * OFF (default) -> landlord payouts flow normally.
 *
 * Polled (60s + on focus). treasury_controls is not in the Realtime
 * publication, so the old postgres_changes listener never fired and a flip
 * only showed after reload (doc 147).
 */
export function useLandlordPayoutsBlocked(): {
  blocked: boolean;
  loading: boolean;
  lastUpdatedAt: Date | null;
  refresh: () => Promise<void>;
} {
  const [blocked, setBlocked] = useState(false);
  const [loading, setLoading] = useState(true);

  const { lastUpdatedAt, refresh } = usePolling(async () => {
    const { data } = await supabase
      .from('treasury_controls')
      .select('enabled')
      .eq('control_key', 'landlord_payouts_blocked')
      .maybeSingle();
    setBlocked(!!data?.enabled);
    setLoading(false);
  }, 60_000, { immediate: true });

  return { blocked, loading, lastUpdatedAt, refresh };
}

export default useLandlordPayoutsBlocked;
