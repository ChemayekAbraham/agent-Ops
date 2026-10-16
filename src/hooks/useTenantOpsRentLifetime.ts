import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { LIFETIME_PAGE_SIZE, normalizeLifetime, normalizeLifetimeList, type LifetimeBucket, type RentLifetime } from '@/lib/rentLifetime';

/**
 * Read-only: the all-time rent request journey and the financed repayment outcome, from tenant_ops_rent_request_lifetime(). The function takes
 * no dates and neither does this hook, so the page's date filter never changes what it returns. The server decides every figure.
 */
export function useTenantOpsRentLifetime(enabled = true) {
  const q = useQuery({
    queryKey: ['tenant-ops-rent-lifetime'],
    enabled,
    staleTime: 5 * 60_000,
    queryFn: async (): Promise<RentLifetime> => {
      const { data, error } = await supabase.rpc('tenant_ops_rent_request_lifetime');
      if (error) throw error;
      return normalizeLifetime(data);
    },
  });
  return {
    data: q.data ?? null,
    isLoading: q.isLoading,
    isFetching: q.isFetching,
    error: q.error ?? null,
    updatedAt: q.dataUpdatedAt,
    refetch: () => { void q.refetch(); },
  };
}

/** The requests behind one row of the all-time cards, 50 at a time. Only asked for once the sheet is open. */
export function useTenantOpsRentLifetimeList(bucket: LifetimeBucket | null, page: number) {
  const q = useQuery({
    queryKey: ['tenant-ops-rent-lifetime-list', bucket, page],
    enabled: bucket != null,
    staleTime: 5 * 60_000,
    placeholderData: keepPreviousData,
    queryFn: async () => {
      const { data, error } = await supabase.rpc('tenant_ops_rent_request_lifetime_list', {
        p_bucket: bucket as LifetimeBucket, p_limit: LIFETIME_PAGE_SIZE, p_offset: page * LIFETIME_PAGE_SIZE,
      });
      if (error) throw error;
      return normalizeLifetimeList(data);
    },
  });
  const rows = q.data ?? [];
  return {
    rows,
    total: rows[0]?.total_matched ?? 0,
    isLoading: q.isLoading,
    isFetching: q.isFetching,
    error: q.error ?? null,
    refetch: () => { void q.refetch(); },
  };
}
