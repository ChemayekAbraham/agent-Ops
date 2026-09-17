import { useEffect, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';

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
 * Realtime so every open queue reacts the moment the CTO flips the switch.
 */
export function useLandlordPayoutsBlocked(): { blocked: boolean; loading: boolean } {
  const [blocked, setBlocked] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const { data } = await supabase
        .from('treasury_controls')
        .select('enabled')
        .eq('control_key', 'landlord_payouts_blocked')
        .maybeSingle();
      if (!cancelled) {
        setBlocked(!!data?.enabled);
        setLoading(false);
      }
    };
    void load();

    const channel = supabase
      .channel('landlord_payouts_blocked_flag')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'treasury_controls', filter: 'control_key=eq.landlord_payouts_blocked' },
        (payload: any) => {
          const next = payload?.new?.enabled;
          if (typeof next === 'boolean') setBlocked(next);
        },
      )
      .subscribe();

    return () => {
      cancelled = true;
      void supabase.removeChannel(channel);
    };
  }, []);

  return { blocked, loading };
}

export default useLandlordPayoutsBlocked;
