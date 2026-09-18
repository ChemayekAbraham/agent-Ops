import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { format, startOfDay } from 'date-fns';

export interface TenantOpsAcquisition {
  newToday: number;
  newThisWeek: number;
  newThisMonth: number;
  growthPct: number | null;
  applicationsToday: number;
  applicationsApproved: number;
  applicationsRejected: number;
  trend: { date: string; fullDate: string; count: number; approvedCount: number }[];
  byLocation: { label: string; value: number }[];
  byServiceCentre: {
    label: string;
    value: number;
    /** Agents rostered to this centre (stationed, manager or their sub-agents). */
    agents: number;
    /** Every tenant ever registered by the centre's agents, active or not. */
    totalTenants: number;
  }[];
  byAgent: { label: string; value: number }[];

}

// Statuses that represent an application that passed review (existing lifecycle states).
const APPROVED_STATUSES = [
  'tenant_ops_approved',
  'agent_ops_approved',
  'landlord_ops_approved',
  'coo_approved',
  'funded',
  'repaying',
  'completed',
];

interface GeoRow {
  key: string;
  label: string;
  agent_id: string | null;
  tenants_total: number;
  /**
   * Tenants on a live rent plan (status funded/repaying and not flagged
   * not_paying) — the same "active" definition Agent Ops performance uses via
   * `v_tenant_ops_tenant_base.is_active`.
   */
  tenants_active: number;
}

interface ServiceCentreRow {
  centre_label: string;
  centre_status: string | null;
  agents: number;
  active_tenants: number;
  total_tenants: number;
}


const emptyAcquisition: TenantOpsAcquisition = {
  newToday: 0,
  newThisWeek: 0,
  newThisMonth: 0,
  growthPct: null,
  applicationsToday: 0,
  applicationsApproved: 0,
  applicationsRejected: 0,
  trend: [],
  byLocation: [],
  byServiceCentre: [],
  byAgent: [],
};

export function useTenantOpsAcquisition(enabled: boolean = true) {
  return useQuery({
    queryKey: ['tenant-ops-acquisition'],
    enabled,
    staleTime: 120000,
    refetchInterval: 180000,
    queryFn: async (): Promise<TenantOpsAcquisition> => {
      const now = new Date();
      const todayStart = startOfDay(now);

      const [
        acquisitionRes,
        applicationsTodayRes,
        applicationsApprovedRes,
        applicationsRejectedRes,
        districtGeoRes,
        agentGeoRes,
        serviceCentreRes,
      ] = await Promise.all([

        supabase.rpc('get_tenant_ops_acquisition'),
        supabase
          .from('rent_requests')
          .select('id', { count: 'exact', head: true })
          .gte('created_at', todayStart.toISOString()),
        supabase
          .from('rent_requests')
          .select('id', { count: 'exact', head: true })
          .in('status', APPROVED_STATUSES),
        supabase
          .from('rent_requests')
          .select('id', { count: 'exact', head: true })
          .eq('status', 'rejected'),
        supabase.rpc('get_tenant_ops_geo_metrics', { p_level: 'district' }),
        supabase.rpc('get_tenant_ops_geo_metrics', { p_level: 'agent' }),
        // Service centre roster + active tenants, computed server-side from the
        // centre entries, approved centre managers and their sub-agents.
        supabase.rpc('get_tenant_ops_service_centre_metrics' as any),
      ]);

      if (acquisitionRes.error) throw acquisitionRes.error;

      // Registration counts (existing tenant source, computed server-side)
      const acq = (acquisitionRes.data || {}) as {
        new_today?: number;
        new_week?: number;
        new_month?: number;
        prev_month?: number;
        trend?: { date: string; count: number }[];
        approved_trend?: { date: string; count: number }[];
      };
      const newToday = acq.new_today || 0;
      const newThisWeek = acq.new_week || 0;
      const newThisMonth = acq.new_month || 0;
      const prevMonth = acq.prev_month || 0;

      // Same 30-day generate_series as `trend`, so both arrays are always the
      // same length and day-order — safe to zip by index.
      const approvedTrend = acq.approved_trend || [];
      const trend = (acq.trend || []).map((t, i) => {
        const day = new Date(t.date);
        return {
          date: format(day, 'd MMM'),
          fullDate: format(day, 'EEE, d MMM yyyy'),
          count: t.count,
          approvedCount: approvedTrend[i]?.count ?? 0,
        };
      });

      const growthPct =
        prevMonth > 0 ? ((newThisMonth - prevMonth) / prevMonth) * 100 : null;

      // Geo breakdowns (existing RPC data). These charts show ACTIVE tenants
      // (funded / repaying, excluding not_paying) so they match Agent Ops
      // performance, instead of every tenant record ever created.
      const activeOf = (r: GeoRow) => Number(r.tenants_active) || 0;

      const districtRows = ((districtGeoRes.data || []) as GeoRow[]).filter(
        (r) => r.key !== 'unassigned'
      );
      const byLocation = districtRows
        .map((r) => ({ label: r.label, value: activeOf(r) }))
        .filter((r) => r.value > 0)
        .sort((a, b) => b.value - a.value);

      const agentRows = (agentGeoRes.data || []) as GeoRow[];
      const byAgent = agentRows
        .filter((r) => r.key !== 'unassigned')
        .map((r) => ({ label: r.label, value: activeOf(r) }))
        .filter((r) => r.value > 0)
        .sort((a, b) => b.value - a.value);

      // Service centre grouping (server-side): each verified/pending centre plus
      // every approved service centre manager, with their active sub-agents
      // rolled into the same centre. Field agents are shown separately so the
      // chart accounts for the whole active book.
      const centreRows = (serviceCentreRes?.data || []) as ServiceCentreRow[];
      const byServiceCentre = centreRows
        .map((r) => ({
          label: r.centre_label,
          value: Number(r.active_tenants) || 0,
          agents: Number(r.agents) || 0,
          totalTenants: Number(r.total_tenants) || 0,
        }))
        .filter((r) => r.value > 0 || r.agents > 0)
        .sort((a, b) => b.value - a.value);


      return {
        newToday,
        newThisWeek,
        newThisMonth,
        growthPct,
        applicationsToday: applicationsTodayRes.count || 0,
        applicationsApproved: applicationsApprovedRes.count || 0,
        applicationsRejected: applicationsRejectedRes.count || 0,
        trend,
        byLocation,
        byServiceCentre,
        byAgent,
      };
    },
    placeholderData: emptyAcquisition,
  });
}
