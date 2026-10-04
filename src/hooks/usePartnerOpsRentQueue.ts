import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

export interface PartnerOpsRentRow {
  id: string;
  status: string;
  created_at: string;
  landlord_ops_reviewed_at: string | null;
  rent_amount: number;
  duration_days: number | null;
  daily_repayment: number | null;
  total_repayment: number | null;
  house_category: string | null;
  request_city: string | null;
  registration_type: string | null;
  tenant_id: string | null;
  tenant_name: string;
  tenant_phone: string | null;
  agent_id: string | null;
  agent_name: string | null;
  agent_phone: string | null;
  landlord_name: string | null;
  landlord_phone: string | null;
  proxy_agent_id: string | null;
  proxy_agent_name: string | null;
  proxy_agent_phone: string | null;
  partner_ops_comment: string | null;
  partner_ops_reviewed_at: string | null;
  agent_ops_comment: string | null;
  tenant_ops_comment: string | null;
  landlord_ops_comment: string | null;
  tenant_photo_url: string | null;
  house_image_urls: string[];
  latest_rent_receipt_url: string | null;
  latest_rent_receipt_uploaded_at: string | null;
}

export interface VerifiedProxyAgent {
  agent_user_id: string;
  full_name: string;
  phone: string | null;
  approved_at: string | null;
}

export interface PartnerOpsRentQueue {
  total: number;
  limit: number;
  offset: number;
  status: string;
  rows: PartnerOpsRentRow[];
  proxy_agents: VerifiedProxyAgent[];
}

export const PARTNER_OPS_RENT_PAGE_SIZE = 20;

/**
 * One round trip per page: the RPC returns the queue rows (already joined with
 * tenant/agent/landlord names and every attached media URL) AND the list of
 * verified proxy agents, so the screen never fans out into per-row lookups.
 */
export function usePartnerOpsRentQueue(params: {
  status: 'landlord_ops_approved' | 'partner_ops_approved';
  search: string;
  page: number;
}) {
  const { status, search, page } = params;
  return useQuery({
    queryKey: ['partner-ops-rent-queue', status, search, page],
    queryFn: async (): Promise<PartnerOpsRentQueue> => {
      const { data, error } = await supabase.rpc('partner_ops_list_rent_requests', {
        p_status: status,
        p_search: search.trim() || null,
        p_limit: PARTNER_OPS_RENT_PAGE_SIZE,
        p_offset: page * PARTNER_OPS_RENT_PAGE_SIZE,
      });
      if (error) throw error;
      const payload = (data ?? {}) as unknown as PartnerOpsRentQueue;
      return {
        total: payload.total ?? 0,
        limit: payload.limit ?? PARTNER_OPS_RENT_PAGE_SIZE,
        offset: payload.offset ?? 0,
        status: payload.status ?? status,
        rows: payload.rows ?? [],
        proxy_agents: payload.proxy_agents ?? [],
      };
    },
    staleTime: 20_000,
  });
}
