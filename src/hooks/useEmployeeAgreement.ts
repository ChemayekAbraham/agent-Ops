import { useState, useEffect, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { toast } from 'sonner';

const CURRENT_VERSION = 'v1.0';

interface EmployeeAgreementAcceptance {
  id: string;
  user_id: string;
  agreement_version: string;
  accepted_at: string;
  status: string;
}

export function useEmployeeAgreement() {
  const { user } = useAuth();
  const [isAccepted, setIsAccepted] = useState<boolean | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [acceptance, setAcceptance] = useState<EmployeeAgreementAcceptance | null>(null);

  const checkAcceptance = useCallback(async () => {
    if (!user?.id) { setIsLoading(false); return; }
    try {
      const { data, error } = await (supabase
        .from('employee_agreement_acceptance' as any)
        .select('*')
        .eq('user_id', user.id)
        .eq('agreement_version', CURRENT_VERSION)
        .eq('status', 'accepted')
        .order('accepted_at', { ascending: false })
        .limit(1)
        .maybeSingle() as any);
      if (error) throw error;
      setAcceptance(data);
      setIsAccepted(!!data);
    } catch (e) {
      console.error('[useEmployeeAgreement]', e);
      setIsAccepted(false);
    } finally {
      setIsLoading(false);
    }
  }, [user?.id]);

  useEffect(() => { checkAcceptance(); }, [checkAcceptance]);

  const acceptAgreement = async (): Promise<boolean> => {
    if (!user?.id) { toast.error('You must be logged in'); return false; }
    try {
      const deviceInfo = navigator.userAgent;
      let ipAddress: string | null = null;
      try { const r = await fetch('https://api.ipify.org?format=json'); ipAddress = (await r.json()).ip; } catch {}

      const { data, error } = await (supabase
        .from('employee_agreement_acceptance' as any)
        .insert({ user_id: user.id, agreement_version: CURRENT_VERSION, ip_address: ipAddress, device_info: deviceInfo, status: 'accepted' })
        .select()
        .single() as any);
      if (error) throw error;

      // Mark on staff_profiles too
      await (supabase.from('staff_profiles' as any).update({ agreement_accepted: true } as any).eq('user_id', user.id) as any);

      setAcceptance(data);
      setIsAccepted(true);
      toast.success('Employment contract accepted!');
      return true;
    } catch (e) {
      console.error('[useEmployeeAgreement] accept error:', e);
      toast.error('Failed to accept. Please try again.');
      return false;
    }
  };

  return { isAccepted, isLoading, acceptance, acceptAgreement, currentVersion: CURRENT_VERSION, refetch: checkAcceptance };
}
