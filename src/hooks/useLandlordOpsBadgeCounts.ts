import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

/**
 * Backlog counters shared by the Landlord Ops shell (sidebar badges) and its
 * Today landing page.
 *
 * Each query below deliberately reuses the exact filter the panel behind that
 * destination already applies, so a badge can never disagree with the queue it
 * points at. No new logic.
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

  // Mirrors Lc1VerificationInboxPanel's `pending` bucket: chairpersons still
  // being vetted by their Service Centre manager are not yet Landlord Ops work.
  const pendingLc1 = useQuery({
    queryKey: ['landlord-ops-lc1-pending-count'],
    staleTime: 30_000,
    queryFn: async () => {
      const { count } = await supabase
        .from('v_lc1_verification_inbox')
        .select('lc1_id', { count: 'exact', head: true })
        .neq('service_center_status', 'pending')
        .eq('status', 'pending');
      return count || 0;
    },
  });

  // Mirrors <RentPipelineQueue stage="tenant_ops_approved" /> — the stage that
  // is waiting on Landlord Ops.
  const pendingPipeline = useQuery({
    queryKey: ['landlord-ops-pipeline-pending-count'],
    staleTime: 30_000,
    queryFn: async () => {
      const { count } = await supabase
        .from('rent_requests')
        .select('id', { count: 'exact', head: true })
        .eq('status', 'tenant_ops_approved');
      return count || 0;
    },
  });

  // Mirrors <LandlordOpsPayoutReview reviewRole="landlord_ops" />.
  const pendingPayouts = useQuery({
    queryKey: ['landlord-ops-payouts-pending-count'],
    staleTime: 30_000,
    queryFn: async () => {
      const { count } = await supabase
        .from('agent_landlord_payouts')
        .select('id', { count: 'exact', head: true })
        .eq('status', 'pending_landlord_ops');
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
    pendingLc1: pendingLc1.data ?? 0,
    pendingPipeline: pendingPipeline.data ?? 0,
    pendingPayouts: pendingPayouts.data ?? 0,
    paidLandlords: paidLandlords.data ?? 0,
    isLoading:
      pendingHouses.isLoading ||
      pendingLandlords.isLoading ||
      pendingLc1.isLoading ||
      pendingPipeline.isLoading ||
      pendingPayouts.isLoading,
  };
}
