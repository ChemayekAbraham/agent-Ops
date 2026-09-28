import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

/**
 * Posted commission credits for the signed-in proxy agent, read straight from
 * the ledger. Row-level security limits this to the caller's own entries.
 */
export const PROXY_COMMISSION_CATEGORIES = [
  'agent_commission', 'proxy_investment_commission', 'agent_investment_commission', 'partner_commission',
] as const;

export interface ProxyEarningRow {
  id: string;
  transaction_date: string;
  amount: number;
  category: string;
  description: string | null;
  source_table: string | null;
}

export type EarningKind = 'note' | 'initial' | 'topup' | 'other';
export const earningKind = (r: ProxyEarningRow): EarningKind => {
  if (r.category === 'agent_commission') return r.source_table === 'promissory_notes' ? 'note' : 'other';
  if (r.category === 'partner_commission') return 'topup';
  return 'initial';
};

export function useProxyEarningsHistory(userId: string | undefined, fromIso?: string) {
  return useQuery({
    queryKey: ['proxy-earnings-history', userId, fromIso ?? 'all'],
    enabled: !!userId,
    staleTime: 60_000,
    queryFn: async (): Promise<ProxyEarningRow[]> => {
      let q = supabase
        .from('general_ledger')
        .select('id, transaction_date, amount, category, description, source_table')
        .eq('user_id', userId!)
        .eq('direction', 'cash_in')
        .in('category', PROXY_COMMISSION_CATEGORIES as unknown as string[])
        .neq('classification', 'admin_correction')
        .order('transaction_date', { ascending: false })
        .limit(300);
      if (fromIso) q = q.gte('transaction_date', fromIso);
      const { data, error } = await q;
      if (error) throw new Error(error.message);
      return ((data ?? []) as ProxyEarningRow[]).filter((r) => r.category !== 'agent_commission' || r.source_table === 'promissory_notes');
    },
  });
}
