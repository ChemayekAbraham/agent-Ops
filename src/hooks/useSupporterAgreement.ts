import { useState, useEffect, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';

const CURRENT_AGREEMENT_VERSION = 'v1.0';

interface AgreementAcceptance {
  id: string;
  supporter_id: string;
  agreement_version: string;
  accepted_at: string;
  ip_address: string | null;
  device_info: string | null;
  status: string;
}

export function useSupporterAgreement() {
  const { user } = useAuth();
  const [hasAccepted, setHasAccepted] = useState<boolean | null>(null);
  const [acceptance, setAcceptance] = useState<AgreementAcceptance | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const checkAcceptance = useCallback(async () => {
    if (!user) {
      setLoading(false);
      return;
    }

    try {
      const { data, error: fetchError } = await supabase
        .from('supporter_agreement_acceptance')
        .select('*')
        .eq('supporter_id', user.id)
        .eq('agreement_version', CURRENT_AGREEMENT_VERSION)
        .eq('status', 'accepted')
        .order('accepted_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (fetchError) throw fetchError;

      setHasAccepted(!!data);
      setAcceptance(data);
    } catch (err: any) {
      setError(err.message);
      setHasAccepted(false);
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => {
    checkAcceptance();
  }, [checkAcceptance]);

  const acceptAgreement = async (): Promise<boolean> => {
    if (!user) {
      setError('You must be logged in to accept the agreement');
      return false;
    }

    setLoading(true);
    setError(null);

    try {
      // Get device info
      const deviceInfo = `${navigator.userAgent}`;
      
      // Try to get IP address (will be null if it fails, which is fine)
      let ipAddress: string | null = null;
      try {
        const ipResponse = await fetch('https://api.ipify.org?format=json');
        const ipData = await ipResponse.json();
        ipAddress = ipData.ip;
      } catch {
        // IP fetch failed, continue without it
      }

      const { data, error: insertError } = await supabase
        .from('supporter_agreement_acceptance')
        .insert({
          supporter_id: user.id,
          agreement_version: CURRENT_AGREEMENT_VERSION,
          ip_address: ipAddress,
          device_info: deviceInfo,
          status: 'accepted'
        })
        .select()
        .single();

      if (insertError) throw insertError;

      setHasAccepted(true);
      setAcceptance(data);
      return true;
    } catch (err: any) {
      setError(err.message || 'Acceptance failed. Please try again.');
      return false;
    } finally {
      setLoading(false);
    }
  };

  return {
    hasAccepted,
    acceptance,
    loading,
    error,
    acceptAgreement,
    refreshAcceptance: checkAcceptance,
    currentVersion: CURRENT_AGREEMENT_VERSION
  };
}
