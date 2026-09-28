/** Reads tops_portfolio_quality(p_as_at) — PAR@7/14/30, repayment/completion/repeat rate by funding month. Our own read-model, additive alongside the existing frozen weekly snapshot. */
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

const anyDb = supabase as any;

export interface ParBucket {
  rate: number | null;
  at_risk_ugx: number;
}

export interface PortfolioQualityCohort {
  funding_month: string;
  plan_count: number;
  repayment_rate_day14: number | null;
  repayment_rate_day30: number | null;
  repayment_rate_at_term: number | null;
  term_elapsed_plan_count: number;
  completion_rate: number | null;
  repeat_rate: number | null;
}

export interface PortfolioQuality {
  as_at: string;
  par: {
    days_7: ParBucket;
    days_14: ParBucket;
    days_30: ParBucket;
    total_outstanding_ugx: number;
  };
  by_funding_month: PortfolioQualityCohort[];
  basis: string;
}

async function fetchPortfolioQuality(asAt: string | null): Promise<PortfolioQuality> {
  const { data, error } = await anyDb.rpc('tops_portfolio_quality', { p_as_at: asAt });
  if (error) throw error;
  return data as PortfolioQuality;
}

export function usePortfolioQuality(asAt: string | null) {
  return useQuery({
    queryKey: ['tenantOpsWorkspace', 'portfolioQuality', asAt],
    queryFn: () => fetchPortfolioQuality(asAt),
    staleTime: 60_000,
  });
}
