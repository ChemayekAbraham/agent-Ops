import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import {
  normalizeRow,
  normalizeSummary,
  type First7Row,
  type First7Summary,
  type FrequencyFilter,
} from '@/lib/newTenantFirst7';

export interface NewTenantFirst7Args {
  from: string;
  to: string;
  freq: FrequencyFilter;
}

const rpcArgs = ({ from, to, freq }: NewTenantFirst7Args) => ({
  p_from: from,
  p_to: to,
  ...(freq !== 'all' ? { p_frequency: freq } : {}),
});

// The functions are newer than the generated Supabase types, hence the cast. Everything returned is normalised in lib/newTenantFirst7.
const rpc = supabase.rpc as unknown as (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }>;

/**
 * Read-only: the plans first paid to the landlord in the range with their seven days (am_new_tenant_first7_v2), and the same plans
 * added up on the server (am_new_tenant_first7_summary_v2). The rows and the summary use the same arguments so they always agree.
 */
export function useNewTenantFirst7(args: NewTenantFirst7Args) {
  const key = [args.from, args.to, args.freq] as const;

  const rows = useQuery({
    queryKey: ['am-new-tenant-first7-v2', 'rows', ...key],
    queryFn: async (): Promise<First7Row[]> => {
      const { data, error } = await rpc('am_new_tenant_first7_v2', rpcArgs(args));
      if (error) throw error;
      return ((data ?? []) as Record<string, unknown>[]).map(normalizeRow);
    },
    staleTime: 60_000,
    placeholderData: (previous) => previous,
  });

  const summary = useQuery({
    queryKey: ['am-new-tenant-first7-v2', 'summary', ...key],
    queryFn: async (): Promise<First7Summary> => {
      const { data, error } = await rpc('am_new_tenant_first7_summary_v2', rpcArgs(args));
      if (error) throw error;
      return normalizeSummary(data as Record<string, unknown> | null);
    },
    staleTime: 60_000,
    placeholderData: (previous) => previous,
  });

  return {
    rows: rows.data ?? [],
    summary: summary.data ?? null,
    isLoading: rows.isLoading || summary.isLoading,
    isFetching: rows.isFetching || summary.isFetching,
    error: rows.error ?? summary.error ?? null,
    refetch: () => { void rows.refetch(); void summary.refetch(); },
  };
}
