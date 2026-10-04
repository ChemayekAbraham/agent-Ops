import { useState, useEffect, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from './useAuth';
import { ANGEL_POOL_AGREEMENT_VERSION } from '@/components/angel-pool/agreement/AngelPoolAgreementContent';

export function useAngelPoolAgreement() {
  const { user } = useAuth();
  const [isAccepted, setIsAccepted] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [acceptedAt, setAcceptedAt] = useState<string | null>(null);

  const checkAcceptance = useCallback(async () => {
    if (!user) { setIsLoading(false); return; }
    try {
      const { data, error } = await (supabase
        .from('agent_agreement_acceptance' as any)
        .select('id, accepted_at')
        .eq('agent_id', user.id)
        .eq('agreement_version', ANGEL_POOL_AGREEMENT_VERSION)
        .eq('status', 'accepted')
        .order('accepted_at', { ascending: false })
        .limit(1)
        .maybeSingle() as any);

      if (error) {
        console.error('[useAngelPoolAgreement] Error:', error);
      } else if (data) {
        setIsAccepted(true);
        setAcceptedAt(data.accepted_at);
      } else {
        setIsAccepted(false);
        setAcceptedAt(null);
      }
    } catch (e) {
      console.error('[useAngelPoolAgreement] Exception:', e);
    } finally {
      setIsLoading(false);
    }
  }, [user]);

  useEffect(() => { checkAcceptance(); }, [checkAcceptance]);

  const acceptAgreement = useCallback(async (): Promise<boolean> => {
    if (!user) return false;
    try {
      const deviceInfo = `${navigator.userAgent.substring(0, 100)}`;
      const { error } = await (supabase
        .from('agent_agreement_acceptance' as any)
        .insert({
          agent_id: user.id,
          agreement_version: ANGEL_POOL_AGREEMENT_VERSION,
          device_info: deviceInfo,
          status: 'accepted',
        }) as any);

      if (error) {
        console.error('[useAngelPoolAgreement] Accept error:', error);
        return false;
      }
      setIsAccepted(true);
      setAcceptedAt(new Date().toISOString());
      return true;
    } catch (e) {
      console.error('[useAngelPoolAgreement] Accept exception:', e);
      return false;
    }
  }, [user]);

  return { isAccepted, isLoading, acceptedAt, acceptAgreement, refreshAcceptance: checkAcceptance };
}
