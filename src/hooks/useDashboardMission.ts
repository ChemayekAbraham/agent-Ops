import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { monthKey, isMissionRestricted, type DashboardMission } from '@/lib/dashboardMissions';

function normalize(row: any): DashboardMission | null {
  if (!row) return null;
  let goals: string[] = [];
  if (Array.isArray(row.goals)) goals = row.goals.filter((g: unknown) => typeof g === 'string' && g.trim());
  return {
    id: row.id,
    dashboard_role: row.dashboard_role,
    period_month: row.period_month,
    mission: row.mission ?? null,
    goals,
    is_active: !!row.is_active,
    font_family: row.font_family ?? null,
    posted_by_name: row.posted_by_name ?? null,
    updated_at: row.updated_at,
  };
}

/**
 * Returns the active mission for the given dashboard for the current month.
 * Each dashboard shows ONLY its own unique mission — there is no shared or
 * company-wide fallback, so the CEO must author a distinct mission per dashboard.
 */
export function useDashboardMission(dashboardRole: string | undefined) {
  const month = monthKey();
  return useQuery({
    queryKey: ['dashboard-mission', dashboardRole, month],
    enabled: !!dashboardRole && !isMissionRestricted(dashboardRole as string),
    staleTime: 300000,
    queryFn: async (): Promise<DashboardMission | null> => {
      // End-user / field dashboards never display a mission (CEO can't author them).
      if (isMissionRestricted(dashboardRole as string)) return null;
      const role = dashboardRole as string;
      // Each dashboard surfaces only the mission authored specifically for it.
      const { data, error } = await supabase
        .from('dashboard_missions')
        .select('*')
        .eq('dashboard_role', role)
        .eq('period_month', month)
        .eq('is_active', true)
        .maybeSingle();
      if (error) throw error;
      return normalize(data);
    },
  });
}