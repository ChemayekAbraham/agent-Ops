import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import type { TenantRentRequestRow } from '@/lib/rentRequestProgress';

const COLUMNS =
  'id, status, rent_amount, total_repayment, daily_repayment, duration_days, created_at, ' +
  'service_center_reviewed_at, coo_reviewed_at, approved_at, funded_at, disbursed_at, rejected_at';

/**
 * The signed-in tenant's most recent rent request (RLS: "Tenants view own
 * requests"). Read-only. Refreshes every minute while the tab is open so the
 * tenant sees the request move without reloading.
 */
export function useMyRentRequest() {
  const { user } = useAuth();
  const userId = user?.id ?? null;
  return useQuery<TenantRentRequestRow | null>({
    queryKey: ['my-rent-request', userId],
    enabled: !!userId,
    refetchInterval: 60_000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('rent_requests')
        .select(COLUMNS)
        .eq('tenant_id', userId as string)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      return (data as unknown as TenantRentRequestRow) ?? null;
    },
  });
}
