import { useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { usePolling } from '@/hooks/usePolling';

/**
 * Reads the platform-wide `treasury_controls.withdrawals_paused` flag.
 * When true, all user-facing withdrawal entry points and merchant-agent
 * claim actions must be blocked.
 *
 * Polled (60s + on focus). treasury_controls is not in the Realtime
 * publication, so the old postgres_changes listener never fired and a flip
 * only showed after reload (doc 147).
 */
export function useWithdrawalsPaused() {
  const [paused, setPaused] = useState<boolean>(false);
  const [loading, setLoading] = useState<boolean>(true);

  const { lastUpdatedAt, refresh } = usePolling(async () => {
    const { data } = await supabase
      .from('treasury_controls')
      .select('enabled')
      .eq('control_key', 'withdrawals_paused')
      .maybeSingle();
    setPaused(Boolean((data as { enabled?: boolean } | null)?.enabled));
    setLoading(false);
  }, 60_000, { immediate: true });

  return { paused, loading, lastUpdatedAt, refresh };
}