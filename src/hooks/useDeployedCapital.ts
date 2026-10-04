import { useState, useEffect } from 'react';
import { supabase } from '@/integrations/supabase/client';

const INVESTOR_THRESHOLD = 100000; // UGX 100K

export function useDeployedCapital(userId: string | undefined) {
  const [deployedCapital, setDeployedCapital] = useState<number>(0);
  const [loading, setLoading] = useState(true);
  const [isQualifiedInvestor, setIsQualifiedInvestor] = useState(false);

  useEffect(() => {
    if (!userId) {
      setLoading(false);
      return;
    }

    const fetch = async () => {
      try {
        const { data } = await supabase
          .from('investor_portfolios')
          .select('investment_amount')
          .eq('investor_id', userId)
          .in('status', ['active', 'pending', 'pending_approval']);

        const total = (data || []).reduce((sum, p) => sum + (p.investment_amount || 0), 0);
        setDeployedCapital(total);
        setIsQualifiedInvestor(total >= INVESTOR_THRESHOLD);
      } catch (e) {
        console.warn('[useDeployedCapital] Error:', e);
      } finally {
        setLoading(false);
      }
    };

    fetch();
  }, [userId]);

  return { deployedCapital, isQualifiedInvestor, loading };
}

export const INVESTOR_THRESHOLD_AMOUNT = INVESTOR_THRESHOLD;
