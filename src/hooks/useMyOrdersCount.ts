import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { fetchMyBikeLeases } from '@/hooks/useBikeLeases';

const db = supabase as any;

/**
 * Accurately gets the count of distinct merchandise/bike/phone orders
 * matching the exact deduplicated logic used in MerchandiseStore.
 */
export function useMyOrdersCount(userId?: string | null) {
  return useQuery<number>({
    queryKey: ['my-total-orders-count', userId],
    enabled: !!userId,
    staleTime: 30 * 1000,
    queryFn: async () => {
      if (!userId) return 0;
      try {
        const [bikes, phonesRes, plansRes] = await Promise.all([
          fetchMyBikeLeases(userId).catch(() => []),
          db
            .from('merchandise_sales')
            .select('id')
            .eq('customer_id', userId)
            .ilike('item_name', '%smartphone%'),
          db
            .from('merchandise_recovery_plans')
            .select('id, sale_id, item_name, pricing_basis')
            .eq('customer_id', userId),
        ]);

        const safeBikes = bikes || [];
        const safePhones = phonesRes?.data || [];
        const safePlans = plansRes?.data || [];

        // Exclude bike leases and smartphones from generic plans to prevent double-counting
        const bikeSaleIds = new Set(safeBikes.map((b: any) => b.id).filter(Boolean));
        const phoneSaleIds = new Set(safePhones.map((p: any) => p.id).filter(Boolean));

        const generalPlans = safePlans.filter((p: any) => {
          if (p.sale_id && (bikeSaleIds.has(p.sale_id) || phoneSaleIds.has(p.sale_id))) return false;
          const name = (p.item_name || '').toLowerCase();
          if (name.includes('bike') || name.includes('spiro') || p.pricing_basis === 'spiro_28pct_v2') return false;
          if (name.includes('smartphone') || name.includes('phone')) return false;
          return true;
        });

        // Check for dismissed bike orders in localStorage if on client
        let dismissedCount = 0;
        try {
          const stored = localStorage.getItem(`welile_dismissed_bike_leases_${userId}`);
          if (stored) {
            const dismissedSet = new Set(JSON.parse(stored));
            dismissedCount = safeBikes.filter((b: any) => dismissedSet.has(b.id)).length;
          }
        } catch {}

        const visibleBikesCount = Math.max(0, safeBikes.length - dismissedCount);
        return visibleBikesCount + safePhones.length + generalPlans.length;
      } catch (e) {
        console.error('[useMyOrdersCount] error fetching orders count', e);
        return 0;
      }
    },
  });
}
