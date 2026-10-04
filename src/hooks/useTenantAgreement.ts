import { useState, useEffect, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { toast } from 'sonner';

const CURRENT_AGREEMENT_VERSION = 'v1.0';

interface TenantAgreementAcceptance {
  id: string;
  tenant_id: string;
  agreement_version: string;
  accepted_at: string;
  ip_address: string | null;
  device_info: string | null;
  status: string;
}

export function useTenantAgreement() {
  const { user } = useAuth();
  const [isAccepted, setIsAccepted] = useState<boolean | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [acceptance, setAcceptance] = useState<TenantAgreementAcceptance | null>(null);

  const checkAcceptance = useCallback(async () => {
    if (!user?.id) {
      setIsLoading(false);
      return;
    }

    try {
      const { data, error } = await (supabase
        .from('tenant_agreement_acceptance' as any)
        .select('*')
        .eq('tenant_id', user.id)
        .eq('agreement_version', CURRENT_AGREEMENT_VERSION)
        .eq('status', 'accepted')
        .order('accepted_at', { ascending: false })
        .limit(1)
        .maybeSingle() as any);

      if (error) throw error;

      setAcceptance(data);
      setIsAccepted(!!data);
    } catch (error) {
      console.error('Error checking tenant agreement:', error);
      setIsAccepted(false);
    } finally {
      setIsLoading(false);
    }
  }, [user?.id]);

  useEffect(() => {
    checkAcceptance();
  }, [checkAcceptance]);

  const acceptAgreement = async (): Promise<boolean> => {
    if (!user?.id) {
      toast.error('You must be logged in to accept the agreement');
      return false;
    }

    try {
      const deviceInfo = navigator.userAgent;
      
      let ipAddress: string | null = null;
      try {
        const ipResponse = await fetch('https://api.ipify.org?format=json');
        const ipData = await ipResponse.json();
        ipAddress = ipData.ip;
      } catch {
        // IP fetch failed, continue without it
      }

      const { data, error } = await (supabase
        .from('tenant_agreement_acceptance' as any)
        .insert({
          tenant_id: user.id,
          agreement_version: CURRENT_AGREEMENT_VERSION,
          ip_address: ipAddress,
          device_info: deviceInfo,
          status: 'accepted'
        })
        .select()
        .single() as any);

      if (error) throw error;

      setAcceptance(data);
      setIsAccepted(true);
      toast.success('Agreement accepted successfully!');
      return true;
    } catch (error) {
      console.error('Error accepting agreement:', error);
      toast.error('Acceptance failed. Please try again.');
      return false;
    }
  };

  return {
    isAccepted,
    isLoading,
    acceptance,
    acceptAgreement,
    currentVersion: CURRENT_AGREEMENT_VERSION,
    refetch: checkAcceptance
  };
}
