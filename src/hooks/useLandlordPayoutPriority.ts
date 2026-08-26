import { useEffect, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';

/**
 * Reads the CTO Platform Controls flag `landlord_payout_priority` from
 * `treasury_controls`.
 *
 * ON  (default) → Landlord float payouts are Priority #1: they sit at the top
 *                 of the Merchant Agent Payout Queue and NO other payout may be
 *                 claimed while one is unclaimed.
 * OFF           → the hold is released; landlord payouts process in the usual
 *                 order alongside other withdrawals.
 *
 * The database is still the enforcing authority for proxy-agent priority
 * (`assert_no_urgent_proxy_priority`); this hook keeps the UI identical to what
 * the server will allow. Realtime so every open queue reacts the moment the CTO
 * flips the switch.
 */
export function useLandlordPayoutPriority(): { enforced: boolean; loading: boolean } {
  const [enforced, setEnforced] = useState(true);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const { data } = await supabase
        .from('treasury_controls')
        .select('enabled')
        .eq('control_key', 'landlord_payout_priority')
        .maybeSingle();
      if (!cancelled) {
        // Default to enforced when the row is unreadable/missing (fail safe).
        setEnforced(data ? !!data.enabled : true);
        setLoading(false);
      }
    };
    void load();

    const channel = supabase
      .channel('landlord_payout_priority_flag')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'treasury_controls', filter: 'control_key=eq.landlord_payout_priority' },
        (payload: any) => {
          const next = payload?.new?.enabled;
          if (typeof next === 'boolean') setEnforced(next);
        },
      )
      .subscribe();

    return () => {
      cancelled = true;
      void supabase.removeChannel(channel);
    };
  }, []);

  return { enforced, loading };
}

export default useLandlordPayoutPriority;
