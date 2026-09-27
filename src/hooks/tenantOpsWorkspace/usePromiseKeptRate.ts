/** Reads tops_promise_kept_rate() — an officer's (or, with p_user_id null, everyone's) kept rate for a date range. */
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

const anyDb = supabase as any;

export interface PromiseKeptRate {
  taken: number;
  kept: number;
  partial: number;
  broken: number;
  still_open: number;
  kept_rate_pct: number | null;
}

async function fetchPromiseKeptRate(from: string, to: string, userId: string | null): Promise<PromiseKeptRate> {
  const { data, error } = await anyDb.rpc('tops_promise_kept_rate', { p_from: from, p_to: to, p_user_id: userId });
  if (error) throw error;
  const row = Array.isArray(data) ? data[0] : data;
  return row as PromiseKeptRate;
}

export function usePromiseKeptRate(from: string, to: string, userId: string | null) {
  return useQuery({
    queryKey: ['tenantOpsWorkspace', 'promiseKeptRate', from, to, userId],
    queryFn: () => fetchPromiseKeptRate(from, to, userId),
    staleTime: 30_000,
  });
}
