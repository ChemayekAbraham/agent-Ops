import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';

export interface ServiceCenterPipelineItem {
  id: string;
  status: string;
  created_at: string;
  tenant_id: string | null;
  tenant_name: string | null;
  tenant_phone: string | null;
  agent_id: string | null;
  agent_name: string | null;
  rent_amount: number | null;
  daily_repayment: number | null;
  total_repayment: number | null;
  amount_repaid: number | null;
  duration_days: number | null;
  request_city: string | null;
  service_center_reviewed_at: string | null;
  service_center_comment: string | null;
  agent_ops_reviewed_at: string | null;
  agent_ops_comment: string | null;
  tenant_ops_reviewed_at: string | null;
  tenant_ops_comment: string | null;
  landlord_ops_reviewed_at: string | null;
  landlord_ops_comment: string | null;
  approved_at: string | null;
  approval_comment: string | null;
  funded_at: string | null;
  is_mine_to_vet: boolean;
}

export interface ServiceCenterPipelinePage {
  manager_id: string;
  is_service_center_manager: boolean;
  total: number;
  limit: number;
  offset: number;
  status_counts: Record<string, number>;
  items: ServiceCenterPipelineItem[];
}

export const SERVICE_CENTER_PAGE_SIZE = 10;

/**
 * Server-paged follow-up list of every rent request posted by this manager's
 * sub-agents, with the pipeline stage each tenant has reached. Filtering and
 * paging happen in the database so the page stays fast at any team size.
 */
export function useServiceCenterPipeline(params: {
  statuses?: string[];
  page: number;
  search?: string;
  pageSize?: number;
}) {
  const { user } = useAuth();
  const pageSize = params.pageSize ?? SERVICE_CENTER_PAGE_SIZE;
  const statuses = params.statuses?.length ? params.statuses : null;
  const search = params.search?.trim() || null;

  return useQuery({
    queryKey: ['service-center-pipeline', user?.id, statuses, params.page, search, pageSize],
    enabled: !!user?.id,
    staleTime: 20_000,
    queryFn: async (): Promise<ServiceCenterPipelinePage> => {
      const { data, error } = await (supabase.rpc as any)('get_service_center_pipeline', {
        p_statuses: statuses,
        p_limit: pageSize,
        p_offset: params.page * pageSize,
        p_search: search,
      });
      if (error) throw error;
      return data as ServiceCenterPipelinePage;
    },
  });
}

export interface TenantPaymentRow {
  id: string;
  paid_at: string;
  amount: number;
  source: 'repayment' | 'agent_collection';
  method: string | null;
  reference: string | null;
  collected_by: string | null;
}

export interface TenantPaymentsPage {
  rent_request_id: string;
  total: number;
  total_amount: number;
  limit: number;
  offset: number;
  items: TenantPaymentRow[];
}

/** Paged payment history for one tenant rent plan. */
export function useServiceCenterTenantPayments(
  rentRequestId: string | null,
  page: number,
  pageSize = SERVICE_CENTER_PAGE_SIZE,
) {
  return useQuery({
    queryKey: ['service-center-tenant-payments', rentRequestId, page, pageSize],
    enabled: !!rentRequestId,
    staleTime: 20_000,
    queryFn: async (): Promise<TenantPaymentsPage> => {
      const { data, error } = await (supabase.rpc as any)('get_service_center_tenant_payments', {
        p_rent_request_id: rentRequestId,
        p_limit: pageSize,
        p_offset: page * pageSize,
      });
      if (error) throw error;
      return data as TenantPaymentsPage;
    },
  });
}