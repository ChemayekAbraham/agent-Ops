import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { format } from 'date-fns';

/**
 * Period-scoped tenant acquisition figures for the Tenant Ops Classic home page.
 *
 * This does NOT replace or change any existing tenant statistic. It reuses the
 * same sources the page already reads (`v_tenant_ops_tenant_base` via a
 * read-only RPC, and `rent_requests`) with the same status definitions, simply
 * bounded to the date window selected in the shared Ops date filter.
 */

// Same lifecycle statuses the existing acquisition hook treats as approved.
const APPROVED_STATUSES = [
  'tenant_ops_approved',
  'agent_ops_approved',
  'landlord_ops_approved',
  'coo_approved',
  'funded',
  'repaying',
  'completed',
];

export interface TenantOpsAcquisitionRange {
  newTenants: number;
  applications: number;
  applicationsApproved: number;
  applicationsRejected: number;
  trend: { date: string; fullDate: string; count: number }[];
}

const empty: TenantOpsAcquisitionRange = {
  newTenants: 0,
  applications: 0,
  applicationsApproved: 0,
  applicationsRejected: 0,
  trend: [],
};

export function useTenantOpsAcquisitionRange(startIso: string, endIso: string, enabled = true) {
  return useQuery({
    queryKey: ['tenant-ops-acquisition-range', startIso, endIso],
    enabled,
    staleTime: 120000,
    queryFn: async (): Promise<TenantOpsAcquisitionRange> => {
      const [rangeRes, applicationsRes, approvedRes, rejectedRes] = await Promise.all([
        supabase.rpc('get_tenant_ops_acquisition_range' as any, {
          p_start: startIso,
          p_end: endIso,
        }),
        supabase
          .from('rent_requests')
          .select('id', { count: 'exact', head: true })
          .gte('created_at', startIso)
          .lte('created_at', endIso),
        supabase
          .from('rent_requests')
          .select('id', { count: 'exact', head: true })
          .in('status', APPROVED_STATUSES)
          .gte('created_at', startIso)
          .lte('created_at', endIso),
        supabase
          .from('rent_requests')
          .select('id', { count: 'exact', head: true })
          .eq('status', 'rejected')
          .gte('created_at', startIso)
          .lte('created_at', endIso),
      ]);

      if (rangeRes.error) throw rangeRes.error;

      const payload = (rangeRes.data || {}) as {
        new_tenants?: number;
        trend?: { date: string; count: number }[];
      };

      const trend = (payload.trend || []).map((t) => {
        const day = new Date(t.date);
        return {
          date: format(day, 'd MMM'),
          fullDate: format(day, 'EEE, d MMM yyyy'),
          count: t.count,
        };
      });

      return {
        newTenants: payload.new_tenants || 0,
        applications: applicationsRes.count || 0,
        applicationsApproved: approvedRes.count || 0,
        applicationsRejected: rejectedRes.count || 0,
        trend,
      };
    },
    placeholderData: empty,
  });
}
