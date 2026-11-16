import { useCallback, useEffect, useSyncExternalStore } from 'react';
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

/**
 * One shared answer per account.
 *
 * The tenant dashboard shows the "You must accept Terms" banner, the agreement
 * pop-up and the Settings legal section, and each calls this hook. Each used to
 * keep its own copy of "accepted?", so accepting in the pop-up never cleared
 * the banner until a reload, and tenants accepted again (234 tenants more than
 * once, one 19 times, as of 2026-11-14). Every caller now reads the same entry.
 */
interface AgreementEntry {
  isAccepted: boolean | null;
  isLoading: boolean;
  acceptance: TenantAgreementAcceptance | null;
}

const LOADING: AgreementEntry = { isAccepted: null, isLoading: true, acceptance: null };
const SIGNED_OUT: AgreementEntry = { isAccepted: null, isLoading: false, acceptance: null };

const entries = new Map<string, AgreementEntry>();
const inFlight = new Map<string, Promise<void>>();
const listeners = new Set<() => void>();

function setEntry(userId: string, entry: AgreementEntry) {
  entries.set(userId, entry);
  listeners.forEach((l) => l());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

async function loadAcceptance(userId: string): Promise<void> {
  const running = inFlight.get(userId);
  if (running) return running;
  const run = (async () => {
    try {
      const { data, error } = await (supabase
        .from('tenant_agreement_acceptance' as any)
        .select('*')
        .eq('tenant_id', userId)
        .eq('agreement_version', CURRENT_AGREEMENT_VERSION)
        .eq('status', 'accepted')
        .order('accepted_at', { ascending: false })
        .limit(1)
        .maybeSingle() as any);
      if (error) throw error;
      setEntry(userId, { isAccepted: !!data, isLoading: false, acceptance: data ?? null });
    } catch (error) {
      console.error('Error checking tenant agreement:', error);
      setEntry(userId, { isAccepted: false, isLoading: false, acceptance: null });
    } finally {
      inFlight.delete(userId);
    }
  })();
  inFlight.set(userId, run);
  return run;
}

/** Test helper: forget every cached answer. */
export function __resetTenantAgreementStore() {
  entries.clear();
  inFlight.clear();
}

export function useTenantAgreement() {
  const { user } = useAuth();
  const userId = user?.id ?? null;

  const entry = useSyncExternalStore(
    subscribe,
    () => (userId ? entries.get(userId) ?? LOADING : SIGNED_OUT),
    () => (userId ? entries.get(userId) ?? LOADING : SIGNED_OUT),
  );

  useEffect(() => {
    if (userId && !entries.has(userId)) void loadAcceptance(userId);
  }, [userId]);

  const refetch = useCallback(async () => {
    if (userId) await loadAcceptance(userId);
  }, [userId]);

  const acceptAgreement = async (): Promise<boolean> => {
    if (!userId) {
      toast.error('You must be logged in to accept the agreement');
      return false;
    }
    // Already accepted: say so instead of saving a second acceptance.
    if (entries.get(userId)?.isAccepted) return true;

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
          tenant_id: userId,
          agreement_version: CURRENT_AGREEMENT_VERSION,
          ip_address: ipAddress,
          device_info: deviceInfo,
          status: 'accepted',
        })
        .select()
        .single() as any);

      if (error) throw error;

      // Every banner, button and pop-up reading this account updates at once.
      setEntry(userId, { isAccepted: true, isLoading: false, acceptance: data });
      toast.success('Agreement accepted successfully!');
      return true;
    } catch (error) {
      console.error('Error accepting agreement:', error);
      toast.error('Acceptance failed. Please try again.');
      return false;
    }
  };

  return {
    isAccepted: entry.isAccepted,
    isLoading: entry.isLoading,
    acceptance: entry.acceptance,
    acceptAgreement,
    currentVersion: CURRENT_AGREEMENT_VERSION,
    refetch,
  };
}
