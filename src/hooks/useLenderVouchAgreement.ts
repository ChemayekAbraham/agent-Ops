import { useState, useEffect, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from './useAuth';
import { LENDER_VOUCH_AGREEMENT_VERSION } from '@/components/vouch/agreements';

interface Acceptance {
  id: string;
  lender_user_id: string;
  agreement_version: string;
  accepted_at: string;
  status: string;
}

export function useLenderVouchAgreement() {
  const { user } = useAuth();
  const [isAccepted, setIsAccepted] = useState(false);
  const [acceptance, setAcceptance] = useState<Acceptance | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const check = useCallback(async () => {
    if (!user) { setIsLoading(false); return; }
    try {
      const { data } = await (supabase
        .from('lender_vouch_agreement_acceptance' as any)
        .select('*')
        .eq('lender_user_id', user.id)
        .eq('agreement_version', LENDER_VOUCH_AGREEMENT_VERSION)
        .eq('status', 'accepted')
        .order('accepted_at', { ascending: false })
        .limit(1)
        .maybeSingle() as any);
      if (data) { setIsAccepted(true); setAcceptance(data as Acceptance); }
      else { setIsAccepted(false); setAcceptance(null); }
    } finally { setIsLoading(false); }
  }, [user]);

  useEffect(() => { check(); }, [check]);

  const acceptAgreement = useCallback(async (): Promise<boolean> => {
    if (!user) return false;
    let ip: string | null = null;
    try { ip = (await (await fetch('https://api.ipify.org?format=json')).json()).ip; } catch {}
    const device = `${navigator.userAgent} | ${navigator.platform}`;
    const { data, error } = await (supabase
      .from('lender_vouch_agreement_acceptance' as any)
      .insert({ lender_user_id: user.id, agreement_version: LENDER_VOUCH_AGREEMENT_VERSION, ip_address: ip, device_info: device, status: 'accepted' })
      .select().single() as any);
    if (error) { console.error('[useLenderVouchAgreement]', error); return false; }
    setIsAccepted(true);
    setAcceptance(data as Acceptance);

    // Mark partner record as agreed (if it exists)
    await (supabase.from('lender_partners' as any).update({
      agreement_accepted: true,
      agreement_version: LENDER_VOUCH_AGREEMENT_VERSION,
      agreement_accepted_at: new Date().toISOString(),
    }).eq('user_id', user.id) as any);

    return true;
  }, [user]);

  return { isAccepted, acceptance, isLoading, acceptAgreement, currentVersion: LENDER_VOUCH_AGREEMENT_VERSION };
}
