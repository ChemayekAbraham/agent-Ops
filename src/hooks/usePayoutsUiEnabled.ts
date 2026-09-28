import { useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { usePolling } from '@/hooks/usePolling';

/**
 * Reads the CTO Platform Controls flag `payouts_ui_enabled` from
 * `treasury_controls`. When false (default), Claim + Withdraw buttons
 * across the app stay disabled. When the CTO flips it ON, those buttons
 * become functional again.
 *
 * Polled (60s + on focus). treasury_controls is not in the Realtime
 * publication, so the old postgres_changes listener never fired and a flip
 * only showed after reload (doc 147).
 */
export function usePayoutsUiEnabled(): {
  enabled: boolean;
  loading: boolean;
  lastUpdatedAt: Date | null;
  refresh: () => Promise<void>;
} {
  const [enabled, setEnabled] = useState(false);
  const [loading, setLoading] = useState(true);

  const { lastUpdatedAt, refresh } = usePolling(async () => {
    const { data } = await supabase
      .from('treasury_controls')
      .select('enabled')
      .eq('control_key', 'payouts_ui_enabled')
      .maybeSingle();
    setEnabled(!!data?.enabled);
    setLoading(false);
  }, 60_000, { immediate: true });

  return { enabled, loading, lastUpdatedAt, refresh };
}

export default usePayoutsUiEnabled;
