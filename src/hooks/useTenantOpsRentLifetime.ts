import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { normalizeLifetime, type RentLifetime } from '@/lib/rentLifetime';

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
