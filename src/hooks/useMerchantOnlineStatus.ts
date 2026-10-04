import { useCallback, useEffect, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { useIsMerchantAgent } from '@/hooks/useIsMerchantAgent';

/**
 * Online/Offline availability for a merchant (cash-out) agent.
 *
 * Only ONLINE + active merchant agents receive real-time withdrawal
 * dispatches. Agents are Online by default; going Offline removes them from
 * the dispatch pool without changing their active status.
 */
export function useMerchantOnlineStatus() {
  const { user } = useAuth();
  const { isMerchantAgent } = useIsMerchantAgent();
  const [isOnline, setIsOnline] = useState<boolean>(true);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const refresh = useCallback(async () => {
    if (!user?.id) return;
    const { data } = await supabase
      .from('cashout_agents')
      .select('is_online')
      .eq('agent_id', user.id)
      .maybeSingle();
    setIsOnline((data as { is_online?: boolean } | null)?.is_online ?? true);
    setLoading(false);
  }, [user?.id]);

  useEffect(() => {
    if (isMerchantAgent) void refresh();
    else setLoading(false);
  }, [isMerchantAgent, refresh]);

  const setOnline = useCallback(
    async (next: boolean): Promise<boolean> => {
      setSaving(true);
      const prev = isOnline;
      setIsOnline(next); // optimistic
      const { data, error } = await supabase.rpc('merchant_set_online', { p_online: next });
      setSaving(false);
      if (error || data === false) {
        setIsOnline(prev); // revert
        return false;
      }
      return true;
    },
    [isOnline],
  );

  return { isOnline, setOnline, loading, saving, refresh };
}
