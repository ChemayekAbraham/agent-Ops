import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

/**
 * Backlog counters shared by the Landlord Ops shell (sidebar badges) and its
 * Home landing page.
 *
 * Each query below deliberately reuses the exact query key + query function
 * already used inside `LandlordOpsDashboard`, so the shell reads from the same
 * React Query cache entry instead of issuing extra requests. No new logic.
 */
export function useLandlordOpsBadgeCounts() {
  const pendingHouses = useQuery({
    queryKey: ['exec-house-listings-pending-count'],
    staleTime: 60_000,
    queryFn: async () => {
      const { count } = await supabase
        .from('house_listings')
        .select('id', { count: 'exact', head: true })
        .eq('verified', false)
        .not('status', 'in', '(rejected,delisted)')
        .in('service_center_status', ['not_required', 'passed']);
      return count || 0;
    },
  });

  const pendingLandlords = useQuery({
    queryKey: ['landlord-ops-pending-verification-count'],
    staleTime: 30_000,
    queryFn: async () => {
      const { count } = await supabase
        .from('landlords')
        .select('id', { count: 'exact', head: true })
        // Still with a Service Centre manager → not yet Landlord Ops work.
        .neq('service_center_status', 'pending')
        .or('verified.is.null,verified.eq.false');
      return count || 0;
    },
  });

  const paidLandlords = useQuery({
    queryKey: ['landlord-ops-paid-landlords-count'],
    staleTime: 60_000,
    queryFn: async () => {
      const { data } = await supabase
        .from('disbursement_records')
        .select('landlord_id')
        .not('landlord_id', 'is', null);
      const set = new Set<string>();
      (data || []).forEach((r: { landlord_id: string | null }) => {
        if (r.landlord_id) set.add(r.landlord_id);
      });
      return set.size;
    },
  });

  return {
    pendingHouses: pendingHouses.data ?? 0,
    pendingLandlords: pendingLandlords.data ?? 0,
    paidLandlords: paidLandlords.data ?? 0,
    isLoading: pendingHouses.isLoading || pendingLandlords.isLoading,
  };
}
