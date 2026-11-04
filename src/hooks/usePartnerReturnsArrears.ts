import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

export interface PartnerReturnsArrears {
  portfolioId: string;
  investorId: string;
  expectedReturns: number;
  pledgeMode: 'percent' | 'amount';
  pledgeValue: number;
  /** Part of this Returns payment that belongs to the company's smartphone arrears. */
  arrearsDeduction: number;
  /** Returns minus arrears: what the officer pays the partner. */
  netPayout: number;
  planOutstanding: number;
  planOverdue: number;
}

/**
 * Smartphone arrears held back from each portfolio's Returns, for Partner Ops payout screens.
 * Portfolios with no repayment-from-Returns setting are simply absent from the map.
 */
export function usePartnerReturnsArrears(portfolioIds: string[]) {
  const ids = [...new Set(portfolioIds)].sort();
  return useQuery({
    queryKey: ['partner-ops-returns-arrears', ids],
    enabled: ids.length > 0,
    staleTime: 60_000,
    queryFn: async () => {
      const { data, error } = await (supabase as any).rpc('get_partner_ops_returns_arrears', {
        p_portfolio_ids: ids,
      });
      if (error) throw error;
      const map = new Map<string, PartnerReturnsArrears>();
      for (const r of (data ?? []) as any[]) {
        map.set(r.portfolio_id, {
          portfolioId: r.portfolio_id,
          investorId: r.investor_id,
          expectedReturns: Number(r.expected_returns),
          pledgeMode: r.pledge_mode,
          pledgeValue: Number(r.pledge_value),
          arrearsDeduction: Number(r.arrears_deduction),
          netPayout: Number(r.net_payout),
          planOutstanding: Number(r.plan_outstanding),
          planOverdue: Number(r.plan_overdue),
        });
      }
      return map;
    },
  });
}
