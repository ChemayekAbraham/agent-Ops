import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import {
  format,
  subDays,
  startOfDay,
  startOfWeek,
  startOfMonth,
  subMonths,
  eachDayOfInterval,
} from 'date-fns';

export interface TenantOpsAcquisition {
  newToday: number;
  newThisWeek: number;
  newThisMonth: number;
  growthPct: number | null;
  applicationsToday: number;
  applicationsApproved: number;
  applicationsRejected: number;
  trend: { date: string; fullDate: string; count: number }[];
  byLocation: { label: string; value: number }[];
  byServiceCentre: { label: string; value: number }[];
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
      const weekStart = startOfWeek(now, { weekStartsOn: 1 });
      const monthStart = startOfMonth(now);
      const prevMonthStart = startOfMonth(subMonths(now, 1));
      const trendStart = subDays(todayStart, 29);
      // Oldest data we need: previous month (for growth %) or 30-day trend.
      const fetchFrom = prevMonthStart < trendStart ? prevMonthStart : trendStart;

      // Tenant registration dates (role grant = registration) — paginated, single column.
      const registrations: string[] = [];
      let from = 0;
      const pageSize = 1000;
      for (;;) {
        const { data, error } = await supabase
          .from('user_roles')
          .select('created_at')
          .eq('role', 'tenant')
          .gte('created_at', fetchFrom.toISOString())
          .order('created_at', { ascending: true })
          .range(from, from + pageSize - 1);
        if (error) throw error;
        const rows = data || [];
        for (const r of rows) registrations.push(r.created_at);
        if (rows.length < pageSize) break;
        from += pageSize;
      }

      const [
        applicationsTodayRes,
        applicationsApprovedRes,
        applicationsRejectedRes,
        districtGeoRes,
        agentGeoRes,
        assignmentsRes,
        entriesRes,
      ] = await Promise.all([
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
        supabase
          .from('service_centre_agent_assignments')
          .select('service_centre_id, agent_id')
          .is('unassigned_at', null),
        supabase
          .from('service_centre_entries')
          .select('id, stationed_location'),
      ]);
...
      const centreLabels = new Map<string, string>();
      for (const e of entriesRes.data || []) {
        centreLabels.set(e.id, e.stationed_location || 'Service centre');
      }
      const agentToCentre = new Map<string, string>();
      for (const a of assignmentsRes.data || []) {
        const label = centreLabels.get(a.service_centre_id);
        if (label) agentToCentre.set(a.agent_id, label);
      }
      const centreTotals = new Map<string, number>();
      let fieldAgents = 0;
      for (const r of agentRows) {
        if (r.key === 'unassigned') continue;
        const centre = r.agent_id ? agentToCentre.get(r.agent_id) : undefined;
        if (centre) centreTotals.set(centre, (centreTotals.get(centre) || 0) + r.tenants_total);
        else fieldAgents += r.tenants_total;
      }
      const byServiceCentre = [...centreTotals.entries()]
        .map(([label, value]) => ({ label, value }))
        .sort((a, b) => b.value - a.value);
      if (fieldAgents > 0) {
        byServiceCentre.push({ label: 'Field agents (no service centre)', value: fieldAgents });
      }

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
