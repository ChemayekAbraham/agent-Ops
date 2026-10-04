import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { format, parseISO } from 'date-fns';

/**
 * Daily pipeline trend for Tenant Ops → Classic → Home.
 *
 * Read-only. Every series is aggregated server-side by
 * `get_tenant_ops_pipeline_trend` from the existing authoritative stamps —
 * no business definition is re-derived on the client:
 *   registrations    v_tenant_ops_tenant_base.tenant_created_at
 *   applications     rent_requests.created_at
 *   cooApproved      rent_requests.coo_reviewed_at
 *   cfoFunded        rent_requests.funded_at
 *   landlordFunded   landlord_payouts.disbursed_at
 *   rejected         rent_requests.rejected_at
 */
export interface PipelineTrendPoint {
  date: string;
  fullDate: string;
  registrations: number;
  applications: number;
  cooApproved: number;
  cfoFunded: number;
  landlordFunded: number;
  rejected: number;
}

interface RawPoint {
  date: string;
  registrations: number;
  applications: number;
  coo_approved: number;
  cfo_funded: number;
  landlord_funded: number;
  rejected: number;
}

export function useTenantOpsPipelineTrend(days: number = 30, enabled: boolean = true) {
  return useQuery({
    queryKey: ['tenant-ops-pipeline-trend', days],
    enabled,
    staleTime: 120_000,
    refetchInterval: 180_000,
    queryFn: async (): Promise<PipelineTrendPoint[]> => {
      const { data, error } = await supabase.rpc('get_tenant_ops_pipeline_trend', {
        p_days: days,
      });
      if (error) throw error;
      const payload = (data || {}) as { series?: RawPoint[] };
      return (payload.series || []).map((r) => {
        const day = parseISO(r.date);
        return {
          date: format(day, 'd MMM'),
          fullDate: format(day, 'EEE, d MMM yyyy'),
          registrations: Number(r.registrations) || 0,
          applications: Number(r.applications) || 0,
          cooApproved: Number(r.coo_approved) || 0,
          cfoFunded: Number(r.cfo_funded) || 0,
          landlordFunded: Number(r.landlord_funded) || 0,
          rejected: Number(r.rejected) || 0,
        };
      });
    },
    placeholderData: [],
  });
}
