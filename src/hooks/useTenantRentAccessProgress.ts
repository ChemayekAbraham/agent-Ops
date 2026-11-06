import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

/** Own-account, read-only server figure. Never estimate it from partial dashboard rows. */
export function useTenantRentAccessProgress(userId?: string) {
  return useQuery({
    queryKey: ['tenant-rent-access-progress', userId],
    enabled: Boolean(userId),
    staleTime: 60_000,
    retry: false,
    queryFn: async () => {
      if (!userId) throw new Error('Sign in to see your limit');
      const { data, error } = await supabase.rpc('rent_access_limit_server', { p_tenant: userId });
      if (error) throw error;
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Limit unavailable');
      const limit = Number(data.limit), maxLimit = Number(data.max_limit);
      if (!Number.isFinite(limit) || limit < 0 || !Number.isFinite(maxLimit) || maxLimit <= 0) throw new Error('Limit unavailable');
      return { limit, maxLimit, percent: Math.min(100, Math.max(0, limit / maxLimit * 100)) };
    },
  });
}