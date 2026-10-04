import { useState, useEffect, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from './useAuth';

const FIRST_TX_KEY = 'welile_first_tx_celebrated';

export function useFirstTransactionCelebration() {
  const { user } = useAuth();
  const [shouldCelebrate, setShouldCelebrate] = useState(false);

  // Check if this user has already celebrated their first transaction
  const hasCelebrated = useCallback(() => {
    if (!user) return true;
    const celebrated = localStorage.getItem(`${FIRST_TX_KEY}_${user.id}`);
    return celebrated === 'true';
  }, [user]);

  // Mark first transaction as celebrated
  const markCelebrated = useCallback(() => {
    if (!user) return;
    localStorage.setItem(`${FIRST_TX_KEY}_${user.id}`, 'true');
    setShouldCelebrate(false);
  }, [user]);

  // Check and trigger celebration for first transaction
  const checkFirstTransaction = useCallback(async () => {
    if (!user || hasCelebrated()) return false;

    // Check if user has exactly 1 transaction (just completed their first)
    const { count } = await supabase
      .from('wallet_transactions')
      .select('*', { count: 'exact', head: true })
      .or(`sender_id.eq.${user.id},recipient_id.eq.${user.id}`);

    if (count === 1) {
      setShouldCelebrate(true);
      return true;
    }

    return false;
  }, [user, hasCelebrated]);

  // Trigger celebration manually (called after successful transaction)
  const triggerCelebration = useCallback(async () => {
    if (!user || hasCelebrated()) return;
    
    const shouldFire = await checkFirstTransaction();
    if (shouldFire) {
      // Small delay to let the UI update first
      setTimeout(() => {
        setShouldCelebrate(true);
      }, 500);
    }
  }, [user, hasCelebrated, checkFirstTransaction]);

  return {
    shouldCelebrate,
    markCelebrated,
    triggerCelebration,
    hasCelebrated: hasCelebrated(),
  };
}
