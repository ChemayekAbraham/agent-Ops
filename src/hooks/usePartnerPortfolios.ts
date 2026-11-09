import { withUserSession } from '@/lib/authenticatedRequests';
import { useCallback, useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import type { PortfolioRecord } from '@/hooks/useCapitalOpportunities';
import { useAuthenticatedAudience } from '@/hooks/useAuthenticatedPoll';

const COLUMNS =
  'id, investment_amount, total_roi_earned, roi_percentage, status, portfolio_code, account_name, maturity_date, duration_months, auto_reinvest, roi_mode, next_roi_date, created_at';

const VISIBLE_STATUSES = ['active', 'pending', 'pending_approval', 'matured', 'paused', 'suspended', 'locked'];

const cacheKey = (userId: string) => `partner_portfolios_v1:${userId}`;

function readCache(userId?: string): PortfolioRecord[] | undefined {
  if (!userId) return undefined;
  try {
    const raw = localStorage.getItem(cacheKey(userId));
    return raw ? (JSON.parse(raw) as PortfolioRecord[]) : undefined;
  } catch { return undefined; }
}

/**
 * Dashboard-facing read of the partner's own portfolios.
 * Same source of truth (investor_portfolios) as the Deployed drawer, but with an
 * explicit error state so a failed load is never rendered as "UGX 0".
 *
 * One shared query: the wallet card, the portfolio list and the dashboard shell all read it, so
 * it is fetched once per visit. The last result is kept in localStorage so a repeat visit paints
 * the portfolios at once and refreshes them in the background.
 */
export function usePartnerPortfolios() {
  const ready = useAuthenticatedAudience();
  const { user } = useAuth();
  const userId = user?.id;
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: ['partner-portfolios', userId],
    enabled: ready && !!userId,
    staleTime: 30_000,
    placeholderData: () => readCache(userId),
    queryFn: async () => {
      if (!userId) return [];
      const [byInvestor, byAgent] = await Promise.all([
        withUserSession(() => supabase.from('investor_portfolios').select(COLUMNS)
          .eq('investor_id', userId).in('status', VISIBLE_STATUSES).limit(100)),
        withUserSession(() => supabase.from('investor_portfolios').select(COLUMNS)
          .eq('agent_id', userId).is('investor_id', null).in('status', VISIBLE_STATUSES).limit(100)),
      ]);
      if (byInvestor.error && byAgent.error) throw byInvestor.error;

      const seen = new Set<string>();
      const deduped = [...(byInvestor.data || []), ...(byAgent.data || [])]
        .filter((p: any) => { if (seen.has(p.id)) return false; seen.add(p.id); return true; })
        .map((p: any) => ({ ...p, funded_at: p.created_at } as PortfolioRecord));

      try { localStorage.setItem(cacheKey(userId), JSON.stringify(deduped)); } catch { /* quota / private mode */ }
      return deduped;
    },
  });

  const refetch = useCallback(
    () => queryClient.invalidateQueries({ queryKey: ['partner-portfolios', userId] }),
    [queryClient, userId],
  );

  useEffect(() => {
    window.addEventListener('supporter-contribution-changed', refetch);
    return () => window.removeEventListener('supporter-contribution-changed', refetch);
  }, [refetch]);

  return {
    portfolios: ready ? query.data ?? [] : [],
    // Only "loading" while there is nothing at all to show (no cache, no result).
    loading: !!userId && query.data === undefined && !query.isError,
    error: query.isError ? ((query.error as Error)?.message || 'Failed to load portfolios') : null,
    refetch,
  };
}
