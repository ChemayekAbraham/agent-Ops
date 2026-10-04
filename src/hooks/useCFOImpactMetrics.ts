import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

export interface CFOImpactMetrics {
  totalUsers: number;
  tenantsImpacted: number;
  agentsEarning: number;
  partnersWithPortfolios: number;
  landlordsActive: number;
  landlordsDormant: number;
  asOf: string | null;
  fromCache: boolean;
}

/**
 * CFO Impact Metrics — high-level "lives touched" numbers.
 * Reads pre-aggregated daily_platform_stats (10-min cache) to avoid
 * heavy live-table scans on every CFO dashboard load.
 */
export function useCFOImpactMetrics() {
  return useQuery<CFOImpactMetrics>({
    queryKey: ['cfo-impact-metrics'],
    staleTime: 10 * 60 * 1000, // 10 minutes
    refetchOnWindowFocus: false,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('daily_platform_stats')
        .select('total_users, tenants_impacted_total, agents_earning_30d, partners_with_portfolios, landlords_active_90d, landlords_dormant, stat_date')
        .order('stat_date', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (error) throw error;

      return {
        totalUsers: (data as any)?.total_users ?? 0,
        tenantsImpacted: (data as any)?.tenants_impacted_total ?? 0,
        agentsEarning: (data as any)?.agents_earning_30d ?? 0,
        partnersWithPortfolios: (data as any)?.partners_with_portfolios ?? 0,
        landlordsActive: (data as any)?.landlords_active_90d ?? 0,
        landlordsDormant: (data as any)?.landlords_dormant ?? 0,
        asOf: (data as any)?.stat_date ?? null,
        fromCache: true,
      };
    },
  });
}