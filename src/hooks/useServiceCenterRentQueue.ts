import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';

export interface ServiceCenterQueueRequest {
  id: string;
  status: string;
  created_at: string;
  rent_amount: number;
  duration_days: number | null;
  daily_repayment: number | null;
  total_repayment: number | null;
  house_category: string | null;
  request_city: string | null;
  house_image_urls: string[] | null;
  tenant_photo_url: string | null;
  tenant_id: string | null;
  tenant_name: string | null;
  tenant_phone: string | null;
  agent_id: string | null;
  agent_name: string | null;
  agent_phone: string | null;
  agent_avatar_url: string | null;
  landlord_name: string | null;
  landlord_phone: string | null;
}

export interface ServiceCenterReviewedRequest {
  id: string;
  status: string;
  rent_amount: number;
  tenant_name: string | null;
  agent_name: string | null;
  service_center_reviewed_at: string | null;
  service_center_comment: string | null;
}

export interface ServiceCenterRentQueue {
  manager_id: string;
  is_service_center_manager: boolean;
  pending_count: number;
  pending: ServiceCenterQueueRequest[];
  recent_reviewed: ServiceCenterReviewedRequest[];
}

/**
 * Server-authoritative vetting queue for a Service Center manager. Only rent
 * requests routed to this manager (sub-agent submissions) are returned — the
 * database decides eligibility, never the client.
 */
export function useServiceCenterRentQueue() {
  const { user } = useAuth();
  return useQuery({
    queryKey: ['service-center-rent-queue', user?.id],
    enabled: !!user?.id,
    staleTime: 30_000,
    queryFn: async (): Promise<ServiceCenterRentQueue> => {
      const { data, error } = await (supabase.rpc as any)('get_service_center_rent_queue', {
        p_manager_id: user!.id,
      });
      if (error) throw error;
      return data as ServiceCenterRentQueue;
    },
  });
}

export function useServiceCenterReviewRentRequest() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { requestId: string; decision: 'verify' | 'reject'; comment?: string }) => {
      const { data, error } = await (supabase.rpc as any)('service_center_review_rent_request', {
        p_request_id: input.requestId,
        p_decision: input.decision,
        p_comment: input.comment ?? null,
      });
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['service-center-rent-queue'] });
    },
  });
}
