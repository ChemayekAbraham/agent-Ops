import { useCallback, useEffect, useState } from 'react';
import type { User } from '@supabase/supabase-js';
import { supabase } from '@/integrations/supabase/client';
import { sortFunderHousesByCompleteness } from '@/lib/funderHouseSort';
import type { VirtualHouse } from '@/components/supporter/VirtualHouseCard';

/**
 * VERBATIM COPY of the portfolio reads in SupporterDashboard.tsx
 * (fetchTotalContributed + fetchMyHouses + their localStorage cache), so the V3
 * dashboard decides the inactivity lock and the first-load skeleton exactly as
 * the live dashboard does. Same queries, same filters, same cache key.
 *
 * Keep in step with SupporterDashboard.tsx until both use one shared hook
 * (listed under "Logic later" in the V3 PR). Do not change behaviour here.
 */
export function useFunderV3PortfolioActivity(user: User) {
  const [loading, setLoading] = useState(false);
  const [hasCachedData, setHasCachedData] = useState(() => {
    try { return !!localStorage.getItem(`supporter_houses_${user.id}`); } catch { return false; }
  });

  // Local-first: read cache synchronously in useState init
  const [virtualHouses, setVirtualHouses] = useState<VirtualHouse[]>(() => {
    try {
      const raw = localStorage.getItem(`supporter_houses_${user.id}`);
      if (raw) return sortFunderHousesByCompleteness<VirtualHouse>(JSON.parse(raw).houses || []);
    } catch { /* storage unavailable */ }
    return [];
  });
  const [totalRentContributed, setTotalRentContributed] = useState(() => {
    try {
      const raw = localStorage.getItem(`supporter_houses_${user.id}`);
      if (raw) return JSON.parse(raw).totalRent || 0;
    } catch { /* storage unavailable */ }
    return 0;
  });
  const [, setTotalRoiEarned] = useState(0);
  const [, setHasEverFunded] = useState<boolean | null>(null);

  // Fetch total contributions from ledger + investor_portfolios (bounded query)
  const fetchTotalContributed = useCallback(async () => {
    if (!user?.id) return;
    try {
      const [ledgerResult, portfolioByInvestor, portfolioByAgent] = await Promise.all([
        supabase
          .from('general_ledger')
          .select('amount')
          .eq('user_id', user.id)
          .eq('category', 'supporter_rent_fund')
          .eq('direction', 'cash_out')
          .limit(500),
        supabase
          .from('investor_portfolios')
          .select('id, investment_amount, total_roi_earned, roi_percentage')
          .eq('investor_id', user.id)
          .in('status', ['active', 'pending', 'pending_approval'])
          .limit(100),
        supabase
          .from('investor_portfolios')
          .select('id, investment_amount, total_roi_earned, roi_percentage')
          .eq('agent_id', user.id)
          .is('investor_id', null)
          .in('status', ['active', 'pending', 'pending_approval'])
          .limit(100),
      ]);

      const allPortfolios = [
        ...(!portfolioByInvestor.error && portfolioByInvestor.data ? portfolioByInvestor.data : []),
        ...(!portfolioByAgent.error && portfolioByAgent.data ? portfolioByAgent.data : []),
      ];
      const seen = new Set<string>();
      const portfolioResult = { data: allPortfolios.filter(p => { if (seen.has(p.id)) return false; seen.add(p.id); return true; }), error: null };

      // Read for parity with the live dashboard; the ledger total is not displayed.
      void (!ledgerResult.error && ledgerResult.data
        ? ledgerResult.data.reduce((sum, r) => sum + Number(r.amount), 0)
        : 0);

      const portfolioTotal = !portfolioResult.error && portfolioResult.data
        ? portfolioResult.data.reduce((sum, r) => sum + Number(r.investment_amount), 0)
        : 0;

      const expectedMonthly = portfolioResult.data
        ? portfolioResult.data.reduce((sum, r) => sum + Number(r.investment_amount) * (Number(r.roi_percentage || 15) / 100), 0)
        : 0;
      setTotalRoiEarned(expectedMonthly);

      // Use portfolio total as source of truth — only actual investments
      setTotalRentContributed(portfolioTotal);
    } catch (err) {
      console.error('[SupporterDashboard] Failed to fetch contributions:', err);
    }
  }, [user?.id]);

  useEffect(() => { fetchTotalContributed(); }, [fetchTotalContributed]);

  const HOUSES_CACHE_TTL = 10 * 60 * 1000; // 10 minutes

  const fetchMyHouses = useCallback(async () => {
    // Always serve cache first
    if (hasCachedData) {
      setLoading(false);
      try {
        const cached = localStorage.getItem(`supporter_houses_${user.id}`);
        if (cached) {
          const { timestamp } = JSON.parse(cached);
          if (Date.now() - timestamp < HOUSES_CACHE_TTL) return;
        }
      } catch { /* storage unavailable */ }
    }

    if (!navigator.onLine) {
      setLoading(false);
      return;
    }

    if (!hasCachedData) setLoading(true);

    try {
      const { data, error } = await supabase
        .from('rent_requests')
        .select('id, rent_amount, duration_days, status, funded_at, updated_at, agent_id, request_city')
        .eq('supporter_id', user.id)
        .order('funded_at', { ascending: false })
        .limit(100);

      if (!error && data) {
        const houses: VirtualHouse[] = data.map(r => {
          const city = r.request_city || 'Uganda';

          let paymentHealth: 'green' | 'amber' | 'red' = 'green';
          if (r.status === 'funded' || r.status === 'disbursed') paymentHealth = 'amber';
          if (r.status === 'completed' || r.status === 'repaid') paymentHealth = 'green';
          if (r.status === 'defaulted' || r.status === 'overdue') paymentHealth = 'red';

          return {
            id: r.id,
            shortId: r.id.slice(0, 6).toUpperCase(),
            area: city,
            city,
            rentAmount: Number(r.rent_amount),
            paymentHealth,
            agentManaged: !!r.agent_id,
            updatedAt: r.updated_at || r.funded_at || new Date().toISOString(),
            status: r.status || 'funded',
            durationDays: r.duration_days,
          };
        });

        const totalRent = houses.reduce((sum, h) => sum + h.rentAmount, 0);
        setVirtualHouses(houses);
        setTotalRentContributed((prev: number) => prev || totalRent); // fallback, prefer ledger
        setHasEverFunded(houses.length > 0);

        localStorage.setItem(`supporter_houses_${user.id}`, JSON.stringify({
          houses, totalRent, timestamp: Date.now(),
        }));
        setHasCachedData(true);
      }
    } catch (error) {
      console.error('[SupporterDashboard] Error:', error);
    }
    setLoading(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user.id, hasCachedData]);

  // Fetch funded houses — cache-first (same trigger as the live dashboard: once per user).
  useEffect(() => {
    fetchMyHouses();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user.id]);

  return {
    loading,
    virtualHouses,
    hasActivePortfolios: totalRentContributed > 0,
    fetchTotalContributed,
    fetchMyHouses,
  };
}
