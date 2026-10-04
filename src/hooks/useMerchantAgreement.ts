import { useState, useEffect, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from './useAuth';
import { MERCHANT_AGREEMENT_VERSION } from '@/components/merchant/agreement/MerchantAgreementContent';

export interface MerchantAgreementAcceptance {
  id: string;
  agent_id: string;
  merchant_name: string | null;
  merchant_phone: string | null;
  agreement_version: string;
  accepted_at: string;
  ip_address: string | null;
  device_info: string | null;
  status: string;
}

/**
 * Tracks whether the current agent has accepted the Welile Merchant Agent
 * Agreement (the current version). Acceptance is a formal, audited record —
 * captured with device + IP — so the CFO can see who has signed on to be a
 * Merchant (Cash-Out) Agent.
 */
export function useMerchantAgreement() {
  const { user } = useAuth();
  const [isAccepted, setIsAccepted] = useState(false);
  const [acceptance, setAcceptance] = useState<MerchantAgreementAcceptance | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [accepting, setAccepting] = useState(false);

  const checkAcceptance = useCallback(async () => {
    if (!user) {
      setIsLoading(false);
      return;
    }
    try {
      const { data, error } = await (supabase
        .from('merchant_agreement_acceptance' as any)
        .select('*')
        .eq('agent_id', user.id)
        .eq('agreement_version', MERCHANT_AGREEMENT_VERSION)
        .eq('status', 'accepted')
        .order('accepted_at', { ascending: false })
        .limit(1)
        .maybeSingle() as any);
      if (error) {
        console.error('[useMerchantAgreement] check error:', error);
      } else if (data) {
        setIsAccepted(true);
        setAcceptance(data as MerchantAgreementAcceptance);
      } else {
        setIsAccepted(false);
        setAcceptance(null);
      }
    } catch (e) {
      console.error('[useMerchantAgreement] exception:', e);
    } finally {
      setIsLoading(false);
    }
  }, [user]);

  useEffect(() => {
    checkAcceptance();
  }, [checkAcceptance]);

  const acceptAgreement = useCallback(async (): Promise<boolean> => {
    if (!user) return false;
    setAccepting(true);
    try {
      let ipAddress: string | null = null;
      try {
        const res = await fetch('https://api.ipify.org?format=json');
        const j = await res.json();
        ipAddress = j.ip;
      } catch {
        console.warn('[useMerchantAgreement] could not fetch IP');
      }

      const { data: profile } = await supabase
        .from('profiles')
        .select('full_name, phone')
        .eq('id', user.id)
        .maybeSingle();

      const deviceInfo = `${navigator.userAgent} | ${navigator.platform} | ${window.screen.width}x${window.screen.height}`;

      // Pick up the pre-signup intake captured on /invite/merchant-agent
      // (name, phone, hand-drawn signature). This is what makes the audited
      // acceptance carry the user's actual signature rather than just their
      // typed name.
      let intakeSignature: string | null = null;
      let intakeName: string | null = null;
      let intakePhone: string | null = null;
      try {
        const raw = localStorage.getItem('merchant_agent_intake');
        if (raw) {
          const j = JSON.parse(raw);
          intakeSignature = typeof j?.signature_data_url === 'string' ? j.signature_data_url : null;
          intakeName = typeof j?.full_name === 'string' ? j.full_name : null;
          intakePhone = typeof j?.phone === 'string' ? j.phone : null;
        }
      } catch { /* ignore */ }

      const insertPayload: Record<string, unknown> = {
        agent_id: user.id,
        merchant_name: intakeName ?? profile?.full_name ?? null,
        merchant_phone: intakePhone ?? profile?.phone ?? null,
        agreement_version: MERCHANT_AGREEMENT_VERSION,
        ip_address: ipAddress,
        device_info: intakeSignature
          ? `${deviceInfo} | signature_captured`
          : deviceInfo,
        status: 'accepted',
      };
      if (intakeSignature) insertPayload.signature_data_url = intakeSignature;

      const { error } = await (supabase
        .from('merchant_agreement_acceptance' as any)
        .insert(insertPayload) as any);

      if (error) {
        console.error('[useMerchantAgreement] accept error:', error);
        try {
          const { toast } = await import('sonner');
          toast.error(`Acceptance failed: ${error.message || 'Unknown error'}`);
        } catch { /* ignore */ }
        return false;
      }
      try { localStorage.removeItem('merchant_agent_intake'); } catch { /* ignore */ }
      setIsAccepted(true);
      // Refresh acceptance record in the background (best effort).
      checkAcceptance();
      return true;
    } catch (e) {
      console.error('[useMerchantAgreement] accept exception:', e);
      return false;
    } finally {
      setAccepting(false);
    }
  }, [user]);

  return {
    isAccepted,
    acceptance,
    isLoading,
    accepting,
    acceptAgreement,
    refreshAcceptance: checkAcceptance,
    currentVersion: MERCHANT_AGREEMENT_VERSION,
  };
}
