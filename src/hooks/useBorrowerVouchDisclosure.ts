import { useState, useEffect, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from './useAuth';
import { BORROWER_VOUCH_DISCLOSURE_VERSION } from '@/components/vouch/agreements';

interface Disclosure {
  id: string;
  user_id: string;
  disclosure_version: string;
  acknowledged_at: string;
  vouched_limit_at_acknowledgement: number | null;
}

export function useBorrowerVouchDisclosure() {
  const { user } = useAuth();
  const [hasAcknowledged, setHasAcknowledged] = useState(false);
  const [disclosure, setDisclosure] = useState<Disclosure | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const check = useCallback(async () => {
    if (!user) { setIsLoading(false); return; }
    try {
      const { data } = await (supabase
        .from('borrower_vouch_disclosures' as any)
        .select('*')
        .eq('user_id', user.id)
        .eq('disclosure_version', BORROWER_VOUCH_DISCLOSURE_VERSION)
        .order('acknowledged_at', { ascending: false })
        .limit(1)
        .maybeSingle() as any);
      if (data) { setHasAcknowledged(true); setDisclosure(data as Disclosure); }
      else { setHasAcknowledged(false); setDisclosure(null); }
    } finally { setIsLoading(false); }
  }, [user]);

  useEffect(() => { check(); }, [check]);

  const acknowledge = useCallback(async (opts?: { aiId?: string; vouchedLimit?: number }): Promise<boolean> => {
    if (!user) return false;
    let ip: string | null = null;
    try { ip = (await (await fetch('https://api.ipify.org?format=json')).json()).ip; } catch {}
    const device = `${navigator.userAgent} | ${navigator.platform}`;
    const { data, error } = await (supabase
      .from('borrower_vouch_disclosures' as any)
      .insert({
        user_id: user.id,
        disclosure_version: BORROWER_VOUCH_DISCLOSURE_VERSION,
        ai_id: opts?.aiId ?? null,
        vouched_limit_at_acknowledgement: opts?.vouchedLimit ?? null,
        ip_address: ip,
        device_info: device,
      }).select().single() as any);
    if (error) { console.error('[useBorrowerVouchDisclosure]', error); return false; }
    setHasAcknowledged(true);
    setDisclosure(data as Disclosure);
    return true;
  }, [user]);

  return { hasAcknowledged, disclosure, isLoading, acknowledge, currentVersion: BORROWER_VOUCH_DISCLOSURE_VERSION };
}
