import { useState, useEffect, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import type { PortfolioRecord } from '@/hooks/useCapitalOpportunities';

const COLUMNS =
  'id, investment_amount, total_roi_earned, roi_percentage, status, portfolio_code, account_name, maturity_date, duration_months, auto_reinvest, roi_mode, next_roi_date, created_at';

const VISIBLE_STATUSES = ['active', 'pending', 'pending_approval', 'matured', 'paused', 'suspended', 'locked'];

/**
 * Dashboard-facing read of the partner's own portfolios.
 * Same source of truth (investor_portfolios) as the Deployed drawer, but with an
 * explicit error state so a failed load is never rendered as "UGX 0".
 */
export function usePartnerPortfolios() {
  const { user } = useAuth();
  const [portfolios, setPortfolios] = useState<PortfolioRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchAll = useCallback(async () => {
    if (!user?.id) { setLoading(false); return; }
    setError(null);
    try {
      const [byInvestor, byAgent] = await Promise.all([
        supabase.from('investor_portfolios').select(COLUMNS)
          .eq('investor_id', user.id).in('status', VISIBLE_STATUSES).limit(100),
        supabase.from('investor_portfolios').select(COLUMNS)
          .eq('agent_id', user.id).is('investor_id', null).in('status', VISIBLE_STATUSES).limit(100),
      ]);
      if (byInvestor.error && byAgent.error) throw byInvestor.error;

      const seen = new Set<string>();
      const deduped = [...(byInvestor.data || []), ...(byAgent.data || [])]
        .filter((p: any) => { if (seen.has(p.id)) return false; seen.add(p.id); return true; })
        .map((p: any) => ({ ...p, funded_at: p.created_at } as PortfolioRecord));

      setPortfolios(deduped);
    } catch (err: any) {
      console.error('[usePartnerPortfolios] fetch error:', err);
      setError(err?.message || 'Failed to load portfolios');
    } finally {
      setLoading(false);
    }
  }, [user?.id]);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  useEffect(() => {
    const handler = () => { fetchAll(); };
    window.addEventListener('supporter-contribution-changed', handler);
    return () => window.removeEventListener('supporter-contribution-changed', handler);
  }, [fetchAll]);

  return { portfolios, loading, error, refetch: fetchAll };
}
