import { useState, useEffect, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from './useAuth';
import { LENDING_AGENT_AGREEMENT_VERSION } from '@/components/vouch/agreements';

interface Acceptance {
  id: string;
  agent_user_id: string;
  agreement_version: string;
  accepted_at: string;
  trust_score_at_acceptance: number | null;
  status: string;
}

export function useLendingAgentAgreement() {
  const { user } = useAuth();
  const [isAccepted, setIsAccepted] = useState(false);
  const [acceptance, setAcceptance] = useState<Acceptance | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const check = useCallback(async () => {
    if (!user) { setIsLoading(false); return; }
    try {
      const { data } = await (supabase
        .from('lending_agent_agreement_acceptance' as any)
        .select('*')
        .eq('agent_user_id', user.id)
        .eq('agreement_version', LENDING_AGENT_AGREEMENT_VERSION)
        .eq('status', 'accepted')
        .order('accepted_at', { ascending: false })
        .limit(1)
        .maybeSingle() as any);
      if (data) { setIsAccepted(true); setAcceptance(data as Acceptance); }
      else { setIsAccepted(false); setAcceptance(null); }
    } finally { setIsLoading(false); }
  }, [user]);

  useEffect(() => { check(); }, [check]);

  const acceptAgreement = useCallback(async (trustScore?: number): Promise<boolean> => {
    if (!user) return false;
    let ip: string | null = null;
    try { ip = (await (await fetch('https://api.ipify.org?format=json')).json()).ip; } catch {}
    const device = `${navigator.userAgent} | ${navigator.platform}`;
    const { data, error } = await (supabase
      .from('lending_agent_agreement_acceptance' as any)
      .insert({ agent_user_id: user.id, agreement_version: LENDING_AGENT_AGREEMENT_VERSION, trust_score_at_acceptance: trustScore ?? null, ip_address: ip, device_info: device, status: 'accepted' })
      .select().single() as any);
    if (error) { console.error('[useLendingAgentAgreement]', error); return false; }
    setIsAccepted(true);
    setAcceptance(data as Acceptance);
    return true;
  }, [user]);

  return { isAccepted, acceptance, isLoading, acceptAgreement, currentVersion: LENDING_AGENT_AGREEMENT_VERSION };
}
