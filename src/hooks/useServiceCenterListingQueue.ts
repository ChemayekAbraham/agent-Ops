import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';

/** Supabase errors are plain objects — turn them into real Errors so the UI
 * never renders "[object Object]". */
function toError(error: any): Error {
  if (error instanceof Error) return error;
  const parts = [error?.message, error?.details, error?.hint].filter(Boolean);
  const code = error?.code ? ` (${error.code})` : '';
  return new Error((parts.join(' — ') || 'Unknown database error') + code);
}

export interface ServiceCenterListing {
  id: string;
  title: string | null;
  district: string | null;
  address: string | null;
  village: string | null;
  rent_amount: number | null;
  bedrooms: number | null;
  images: string[] | null;
  latitude: number | null;
  longitude: number | null;
  created_at: string;
  agent_id: string | null;
  agent_name: string | null;
  agent_phone: string | null;
  landlord_id: string | null;
  landlord_name: string | null;
  landlord_phone: string | null;
  service_center_status: string;
}

/**
 * House listings routed to this Service Centre manager for vetting before they
 * reach Landlord Ops. The database decides eligibility, never the client.
 */
export function useServiceCenterListingQueue() {
  const { user } = useAuth();
  return useQuery({
    queryKey: ['service-center-listing-queue', user?.id],
    enabled: !!user?.id,
    staleTime: 30_000,
    queryFn: async (): Promise<ServiceCenterListing[]> => {
      const { data, error } = await (supabase.rpc as any)('get_service_center_listing_queue', {
        p_manager_id: user!.id,
      });
      if (error) throw toError(error);
      return (data as ServiceCenterListing[]) ?? [];
    },
  });
}

export function useServiceCenterReviewListing() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { listingId: string; decision: 'pass' | 'return'; comment?: string }) => {
      const { data, error } = await (supabase.rpc as any)('service_center_review_house_listing', {
        p_listing_id: input.listingId,
        p_decision: input.decision,
        p_comment: input.comment ?? null,
      });
      if (error) throw toError(error);
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['service-center-listing-queue'] });
    },
  });
}