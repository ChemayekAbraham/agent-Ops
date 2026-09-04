import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import {
  housesAwaitingVerification,
  landlordsAwaitingVerification,
  lc1AwaitingVerification,
  rentRequestsAwaitingLandlordOps,
  payoutsAwaitingLandlordOps,
  type QueueFilterable,
} from './landlordOpsQueueFilters';

/**
 * Backlog counters shared by the Landlord Ops shell (sidebar badges) and its
 * Today landing page.
 *
 * Every count applies the queue definition from `landlordOpsQueueFilters`, so a
 * badge can never disagree with the queue it points at.
 */
export function useLandlordOpsBadgeCounts() {
  const pendingHouses = useQuery({
    queryKey: ['exec-house-listings-pending-count'],
    staleTime: 60_000,
    queryFn: async () => {
      const { count } = await housesAwaitingVerification(
        supabase
          .from('house_listings')
          .select('id', { count: 'exact', head: true }) as unknown as QueueFilterable,
      );
      return count || 0;
    },
  });

  const pendingLandlords = useQuery({
    queryKey: ['landlord-ops-pending-verification-count'],
    staleTime: 30_000,
    queryFn: async () => {
      const { count } = await landlordsAwaitingVerification(
        supabase
          .from('landlords')
          .select('id', { count: 'exact', head: true }) as unknown as QueueFilterable,
      );
      return count || 0;
    },
  });

  const pendingLc1 = useQuery({
    queryKey: ['landlord-ops-lc1-pending-count'],
    staleTime: 30_000,
    queryFn: async () => {
      const { count } = await lc1AwaitingVerification(
        supabase
          .from('v_lc1_verification_inbox')
          .select('lc1_id', { count: 'exact', head: true }) as unknown as QueueFilterable,
      );
      return count || 0;
    },
  });

  const pendingPipeline = useQuery({
    queryKey: ['landlord-ops-pipeline-pending-count'],
    staleTime: 30_000,
    queryFn: async () => {
      const { count } = await rentRequestsAwaitingLandlordOps(
        supabase
          .from('rent_requests')
          .select('id', { count: 'exact', head: true }) as unknown as QueueFilterable,
      );
      return count || 0;
    },
  });

  const pendingPayouts = useQuery({
    queryKey: ['landlord-ops-payouts-pending-count'],
    staleTime: 30_000,
    queryFn: async () => {
      const { count } = await payoutsAwaitingLandlordOps(
        supabase
          .from('agent_landlord_payouts')
          .select('id', { count: 'exact', head: true }) as unknown as QueueFilterable,
      );
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
