/**
 * "N+ days, calculated now" for the Weekly Performance page. Reads get_tenant_ops_dormant_amclock(): the same
 * counting as the weekly "20+ days" figure (payout clock), for any N, calculated at this moment. It is NOT part
 * of the frozen weekly record.
 */
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

const anyDb = supabase as any;

export interface TenantOpsDormantNow {
  as_of: string;
  min_days: number;
  count: number;
  count_plus_10: number;
  count_plus_20: number;
  counted_plans: number;
  landlord_not_paid_count: number;
}

export function useTenantOpsDormantNow(minDays: number, enabled: boolean = true) {
  return useQuery({
    queryKey: ['tenant-ops-dormant-now', minDays],
    enabled,
    staleTime: 120_000,
    queryFn: async (): Promise<TenantOpsDormantNow> => {
      const { data, error } = await anyDb.rpc('get_tenant_ops_dormant_amclock', { p_min_days: minDays });
      if (error) throw new Error(error.message);
      return data as TenantOpsDormantNow;
    },
  });
}
