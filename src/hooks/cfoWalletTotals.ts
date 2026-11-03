import { queryOptions } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { cfoReportRetry } from './cfoReportRetry';

/** Share the same response, never substitute total_balance for total_float. */
export const cfoWalletTotalsOptions = () => queryOptions({
  queryKey: ['cfo-wallet-totals'],
  queryFn: async () => {
    const { data, error } = await supabase.rpc('get_wallet_totals');
    if (error) throw error;
    return (data ?? {}) as { total_balance?: number; total_float?: number };
  },
  staleTime: 15_000,
  retry: cfoReportRetry,
});