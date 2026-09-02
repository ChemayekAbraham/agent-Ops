import { useCallback, useEffect, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';

/**
 * Single source of truth for a landlord's agreement status.
 *
 * The canonical record is the immutable, signed `landlord_agreements` register.
 * This hook only reads it — there is no in-app "accept" that can stand in for a
 * signed document, so no competing acceptance record is ever created.
 */
export function useLandlordAgreement() {
  const { user } = useAuth();
  const [isAccepted, setIsAccepted] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [acceptedAt, setAcceptedAt] = useState<string | null>(null);
  const [landlordId, setLandlordId] = useState<string | null>(null);

  const checkAgreementStatus = useCallback(async () => {
    if (!user) {
      setIsLoading(false);
      return;
    }
    setIsLoading(true);
    try {
      const { data: profile } = await supabase
        .from('profiles')
        .select('borrower_landlord_id')
        .eq('id', user.id)
        .maybeSingle();

      const id = (profile as any)?.borrower_landlord_id ?? null;
      setLandlordId(id);
      if (!id) {
        setIsAccepted(false);
        setAcceptedAt(null);
        return;
      }

      const { data, error } = await supabase
        .from('landlord_agreements')
        .select('id, agreement_date, created_at, status, is_current')
        .eq('landlord_id', id)
        .eq('is_current', true)
        .eq('status', 'active')
        .maybeSingle();

      if (error) {
        console.error('[useLandlordAgreement] Error checking status:', error);
        return;
      }
      setIsAccepted(!!data);
      setAcceptedAt(data?.agreement_date ?? data?.created_at ?? null);
    } catch (err) {
      console.error('[useLandlordAgreement] Exception:', err);
    } finally {
      setIsLoading(false);
    }
  }, [user]);

  useEffect(() => {
    void checkAgreementStatus();
  }, [checkAgreementStatus]);

  /**
   * Kept for the existing terms viewer. A signed agreement is the only record
   * that counts, so this never writes a parallel acceptance row.
   */
  const acceptAgreement = async (): Promise<boolean> => false;

  return {
    isAccepted,
    isLoading,
    acceptedAt,
    landlordId,
    acceptAgreement,
    refetch: checkAgreementStatus,
  };
}
