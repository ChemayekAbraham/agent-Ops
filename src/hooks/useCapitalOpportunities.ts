import { useState, useEffect, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import type { OpportunitySummary } from '@/hooks/useOpportunitySummary';

export interface EmptyHouseGroupStat {
  label: string;
  house_count: number;
  total_rent_needed: number;
  monthly_return: number;
}

export interface EmptyHouseOpportunitySummary {
  house_count: number;
  total_rent_needed: number;
  monthly_return_if_all_funded: number;
  avg_monthly_rent: number;
  funded_count: number;
  funded_rent: number;
  total_listed: number;
  districts: EmptyHouseGroupStat[];
  landlords: EmptyHouseGroupStat[];
}

export interface PortfolioRecord {
  id: string;
  investment_amount: number;
  total_roi_earned: number;
  roi_percentage: number;
  status: string;
  portfolio_code: string | null;
  account_name: string | null;
  maturity_date: string | null;
  duration_months: number | null;
  auto_reinvest: boolean | null;
  roi_mode: string | null;
  next_roi_date: string | null;
  created_at: string | null;
  /** Actual running start: the ORIGINAL portfolio's start after following the
   *  renewal chain (locked_from_portfolio_id) to its root, preferring
   *  cfo_verified_at (money confirmed working) over created_at. */
  funded_at: string | null;
}

/** Columns needed to resolve the running start of a portfolio, including
 *  walking renewal chains via locked_from_portfolio_id. */
const PORTFOLIO_CHAIN_COLUMNS = 'id, created_at, cfo_verified_at, locked_from_portfolio_id';

/** Walk locked_from_portfolio_id chains so a renewed portfolio reports the
 *  date its money ORIGINALLY started working, not the renewal row's
 *  created_at. Returns a map of portfolio id -> running start ISO string. */
async function resolveRunningStarts(rows: Array<{ id: string; created_at: string | null; cfo_verified_at: string | null; locked_from_portfolio_id: string | null }>): Promise<Map<string, string>> {
  const byId = new Map(rows.map(r => [r.id, r]));
  // Fetch ancestors referenced by renewal chains (any status — matured/locked
  // rows are excluded from the visible lists but are part of the chain).
  let frontier = rows
    .map(r => r.locked_from_portfolio_id)
    .filter((id): id is string => !!id && !byId.has(id));
  for (let depth = 0; depth < 10 && frontier.length > 0; depth++) {
    const { data } = await supabase
      .from('investor_portfolios')
      .select(PORTFOLIO_CHAIN_COLUMNS)
      .in('id', frontier);
    frontier = [];
    for (const p of data || []) {
      if (byId.has(p.id)) continue;
      byId.set(p.id, p as any);
      if (p.locked_from_portfolio_id && !byId.has(p.locked_from_portfolio_id)) {
        frontier.push(p.locked_from_portfolio_id);
      }
    }
  }
  const result = new Map<string, string>();
  for (const row of rows) {
    let current = row as any;
    const visited = new Set<string>([row.id]);
    while (current.locked_from_portfolio_id && byId.has(current.locked_from_portfolio_id) && !visited.has(current.locked_from_portfolio_id)) {
      current = byId.get(current.locked_from_portfolio_id);
      visited.add(current.id);
    }
    const start = current.cfo_verified_at || current.created_at;
    if (start) result.set(row.id, start);
  }
  return result;
}

export function useCapitalOpportunities() {
  const { user } = useAuth();
  const [portfolios, setPortfolios] = useState<PortfolioRecord[]>([]);
  const [opportunitySummary, setOpportunitySummary] = useState<OpportunitySummary | null>(null);
  const [emptyHouseSummary, setEmptyHouseSummary] = useState<EmptyHouseOpportunitySummary | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchAll = useCallback(async () => {
    if (!user?.id) { setLoading(false); return; }

    try {
      const [byInvestor, byAgent, summaryRes, emptyHousesRes] = await Promise.all([
        supabase
          .from('investor_portfolios')
          .select('id, investment_amount, total_roi_earned, roi_percentage, status, portfolio_code, account_name, maturity_date, duration_months, auto_reinvest, roi_mode, next_roi_date, created_at, cfo_verified_at, locked_from_portfolio_id')
          .eq('investor_id', user.id)
          .in('status', ['active', 'pending', 'pending_approval', 'matured', 'withdrawn'])
          .limit(100),
        supabase
          .from('investor_portfolios')
          .select('id, investment_amount, total_roi_earned, roi_percentage, status, portfolio_code, account_name, maturity_date, duration_months, auto_reinvest, roi_mode, next_roi_date, created_at, cfo_verified_at, locked_from_portfolio_id')
          .eq('agent_id', user.id)
          .is('investor_id', null)
          .in('status', ['active', 'pending', 'pending_approval', 'matured', 'withdrawn'])
          .limit(100),
        supabase
          .from('opportunity_summaries')
          .select('*')
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle(),
        supabase.rpc('empty_house_opportunity_summary'),
      ]);

      // Deduplicate portfolios by id
      const all = [
        ...(!byInvestor.error && byInvestor.data ? byInvestor.data : []),
        ...(!byAgent.error && byAgent.data ? byAgent.data : []),
      ];
      const seen = new Set<string>();
      const deduped = all.filter(p => {
        if (seen.has(p.id)) return false;
        seen.add(p.id);
        return true;
      });

      const starts = await resolveRunningStarts(deduped as any);
      const withStarts = deduped.map(p => ({ ...p, funded_at: starts.get(p.id) ?? p.created_at } as PortfolioRecord));

      setPortfolios(withStarts);

      if (!summaryRes.error && summaryRes.data) {
        setOpportunitySummary(summaryRes.data as OpportunitySummary);
      }

      if (!emptyHousesRes.error && emptyHousesRes.data) {
        const raw = emptyHousesRes.data as Record<string, unknown>;
        const group = (rows: unknown, key: string): EmptyHouseGroupStat[] =>
          Array.isArray(rows)
            ? rows.map((r) => {
                const row = (r ?? {}) as Record<string, unknown>;
                return {
                  label: String(row[key] ?? '—'),
                  house_count: Number(row.house_count ?? 0),
                  total_rent_needed: Number(row.total_rent_needed ?? 0),
                  monthly_return: Number(row.monthly_return ?? 0),
                };
              })
            : [];
        setEmptyHouseSummary({
          house_count: Number(raw.house_count ?? 0),
          total_rent_needed: Number(raw.total_rent_needed ?? 0),
          monthly_return_if_all_funded: Number(raw.monthly_return_if_all_funded ?? 0),
          avg_monthly_rent: Number(raw.avg_monthly_rent ?? 0),
          funded_count: Number(raw.funded_count ?? 0),
          funded_rent: Number(raw.funded_rent ?? 0),
          total_listed: Number(raw.total_listed ?? 0),
          districts: group(raw.districts, 'district'),
          landlords: group(raw.landlords, 'landlord_name'),
        });
      }
    } catch (err) {
      console.error('[useCapitalOpportunities] fetch error:', err);
    } finally {
      setLoading(false);
    }
  }, [user?.id]);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  // Event-driven refresh
  useEffect(() => {
    const handler = () => { fetchAll(); };
    window.addEventListener('supporter-contribution-changed', handler);
    return () => window.removeEventListener('supporter-contribution-changed', handler);
  }, [fetchAll]);

  const totalInvested = portfolios.reduce((s, p) => s + Number(p.investment_amount), 0);
  const portfolioCount = portfolios.length;

  return { portfolios, totalInvested, portfolioCount, opportunitySummary, emptyHouseSummary, loading, refetch: fetchAll };
}
