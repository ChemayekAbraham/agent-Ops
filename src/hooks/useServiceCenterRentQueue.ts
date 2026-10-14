import { useMemo } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import {
  DEFAULT_RENT_DESK_SORT,
  filterByRentDesk,
  orderByRentDesk,
  useRentDeskOrder,
  withRentDeskScores,
  type RentDeskScoreFields,
  type RentDeskSort,
} from '@/hooks/useRentDeskOrder';
import { NO_RENT_DESK_FILTERS, type RentDeskFilters } from '@/lib/rentDeskFilters';

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

/** A pending request once the server's order and the tenant's payment score are joined in. */
export type ServiceCenterQueueRow = ServiceCenterQueueRequest & RentDeskScoreFields;

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
  pending: ServiceCenterQueueRow[];
  recent_reviewed: ServiceCenterReviewedRequest[];
}

export interface ServiceCenterRentQueueOptions {
  sort?: RentDeskSort;
  filters?: RentDeskFilters;
  /** Set false where only the counts are needed (no server order or filter call is made). Default true. */
  ordered?: boolean;
}

/**
 * Server-authoritative vetting queue for a Service Center manager. Only rent
 * requests routed to this manager (sub-agent submissions) are returned — the
 * database decides eligibility, never the client.
 *
 * `pending` is ordered and filtered by the server (`rent_request_desk_order`): "best payers first" by default (tenant payment
 * score high to low, then oldest request first), or `newest` / `oldest`, narrowed by paying label and arrival day. Scores,
 * labels and the count are the server's; `desk.matchCount` is its count of requests that match, and `pending_count` stays the
 * size of the whole queue. The queue itself and the review mutation are unchanged. If the ordering call fails the queue keeps
 * the order it was returned in and shows every request (`desk.error` is set).
 */
export function useServiceCenterRentQueue(options: ServiceCenterRentQueueOptions = {}) {
  const { sort = DEFAULT_RENT_DESK_SORT, filters = NO_RENT_DESK_FILTERS, ordered = true } = options;
  const { user } = useAuth();
  const query = useQuery({
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

  const pendingIds = useMemo(() => (query.data?.pending ?? []).map((r) => r.id), [query.data]);
  const order = useRentDeskOrder(pendingIds, sort, filters, { enabled: ordered });

  const data = useMemo<ServiceCenterRentQueue | undefined>(() => {
    if (!query.data || !order.data) return query.data;
    const scored = withRentDeskScores(query.data.pending, order.data);
    return { ...query.data, pending: filterByRentDesk(orderByRentDesk(scored, order.data), order.data) };
  }, [query.data, order.data]);

  const desk = {
    /** The server's count of requests that match the filters (all of them when there is no filter). */
    matchCount: order.data ? order.data.matchCount : (query.data?.pending.length ?? 0),
    totalCount: order.data ? order.data.totalCount : (query.data?.pending.length ?? 0),
    filtered: !!order.data?.filtered,
    error: order.isError,
  };

  // Counts and the like are available at once; `isLoading` stays true until the order is known (or the ordering call has
  // failed), so the list never reshuffles under the reader.
  return { ...query, data, desk, isLoading: query.isLoading || (ordered && pendingIds.length > 0 && order.isLoading) };
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
      queryClient.invalidateQueries({ queryKey: ['overdue-vetting'] });
    },
  });
}
