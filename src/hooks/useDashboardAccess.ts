/**
 * useDashboardAccess — data for the "Dashboard Access" view (CTO and HR
 * dashboards).
 *
 * Reads get_dashboard_access_overview() and writes through
 * grant_dashboard_access / revoke_dashboard_access. All three are
 * SECURITY DEFINER and refuse anyone but super_admin, CTO or HR
 * (migrations 20261021180000, 20261021190000); `canManage` mirrors that so
 * the view can show a "not allowed" state instead of an error.
 *
 * The view itself (layout, tables, dialogs) belongs in components; this hook
 * holds no UI.
 */
import { useMemo } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useCanEditAccess } from '@/hooks/useCanEditAccess';
import { DASHBOARD_ACCESS_KEYS, dashboardLabel } from '@/lib/dashboardAccessKeys';

// The new RPCs are not in the generated types yet: call them through a
// narrow, typed signature instead of the generated one.
type RpcResult = { data: unknown; error: { message: string } | null };
const rpc = (fn: string, args?: Record<string, unknown>): Promise<RpcResult> =>
  (supabase.rpc as unknown as (f: string, a?: Record<string, unknown>) => Promise<RpcResult>)(fn, args);

type Row = Record<string, unknown>;
const str = (v: unknown): string | null => (v == null ? null : String(v));
const rows = (v: unknown): Row[] => (Array.isArray(v) ? (v as Row[]) : []);

export const DASHBOARD_ACCESS_QUERY_KEY = ['dashboard-access-overview'] as const;

/** One active allowlist entry. */
export interface DashboardAccessGrant {
  grantId: string;
  userId: string;
  fullName: string | null;
  phone: string | null;
  dashboard: string;
  grantedAt: string | null;
  grantedBy: string | null;
  grantedByName: string | null;
}

/**
 * A person whose role works from `dashboard` but who is not on its list —
 * they are locked out of it until granted.
 */
export interface DashboardAccessMissing {
  userId: string;
  fullName: string | null;
  phone: string | null;
  roles: string[];
  dashboard: string;
}

export interface DashboardAccessOverview {
  generatedAt: string;
  grants: DashboardAccessGrant[];
  missing: DashboardAccessMissing[];
}

/** Per-dashboard summary for list/tab views. */
export interface DashboardAccessSummary {
  key: string;
  label: string;
  grants: DashboardAccessGrant[];
  missing: DashboardAccessMissing[];
}

export interface DashboardAccessPerson {
  id: string;
  fullName: string | null;
  phone: string | null;
  email: string | null;
  roles: string[];
}

export function normalizeOverview(raw: unknown): DashboardAccessOverview {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Row;
  return {
    generatedAt: String(r.generated_at ?? ''),
    grants: rows(r.grants).map((g) => ({
      grantId: String(g.grant_id),
      userId: String(g.user_id),
      fullName: str(g.full_name),
      phone: str(g.phone),
      dashboard: String(g.dashboard),
      grantedAt: str(g.granted_at),
      grantedBy: str(g.granted_by),
      grantedByName: str(g.granted_by_name),
    })),
    missing: rows(r.missing).map((m) => ({
      userId: String(m.user_id),
      fullName: str(m.full_name),
      phone: str(m.phone),
      roles: Array.isArray(m.roles) ? m.roles.map(String) : [],
      dashboard: String(m.dashboard),
    })),
  };
}

/** Group grants and locked-out people by dashboard, in the canonical key order. */
export function summarizeByDashboard(overview: DashboardAccessOverview | undefined): DashboardAccessSummary[] {
  return DASHBOARD_ACCESS_KEYS.map(({ key }) => ({
    key,
    label: dashboardLabel(key),
    grants: overview?.grants.filter((g) => g.dashboard === key) ?? [],
    missing: overview?.missing.filter((m) => m.dashboard === key) ?? [],
  }));
}

export function useDashboardAccess() {
  const queryClient = useQueryClient();
  const { canEdit: canManage, loading: checkingAccess } = useCanEditAccess();

  const overviewQuery = useQuery({
    queryKey: DASHBOARD_ACCESS_QUERY_KEY,
    enabled: canManage,
    staleTime: 30_000,
    queryFn: async (): Promise<DashboardAccessOverview> => {
      const { data, error } = await rpc('get_dashboard_access_overview');
      if (error) throw error;
      return normalizeOverview(data);
    },
  });

  const refresh = () => queryClient.invalidateQueries({ queryKey: DASHBOARD_ACCESS_QUERY_KEY });

  const grant = useMutation({
    mutationFn: async (input: { userId: string; dashboard: string; reason?: string }) => {
      const { data, error } = await rpc('grant_dashboard_access', {
        p_user_id: input.userId,
        p_dashboard: input.dashboard,
        p_reason: input.reason?.trim() || null,
      });
      if (error) throw error;
      return data as { ok: boolean; already_granted: boolean; id: string };
    },
    onSuccess: refresh,
  });

  const revoke = useMutation({
    mutationFn: async (input: { userId: string; dashboard: string; reason?: string }) => {
      const { data, error } = await rpc('revoke_dashboard_access', {
        p_user_id: input.userId,
        p_dashboard: input.dashboard,
        p_reason: input.reason?.trim() || null,
      });
      if (error) throw error;
      return data as { ok: boolean; revoked: number };
    },
    onSuccess: refresh,
  });

  const byDashboard = useMemo(() => summarizeByDashboard(overviewQuery.data), [overviewQuery.data]);

  return {
    /** super_admin, CTO or HR. False → show a "not allowed" state, not the view. */
    canManage,
    loading: checkingAccess || (canManage && overviewQuery.isLoading),
    error: overviewQuery.error as Error | null,
    overview: overviewQuery.data,
    byDashboard,
    totals: {
      grants: overviewQuery.data?.grants.length ?? 0,
      lockedOut: overviewQuery.data?.missing.length ?? 0,
    },
    refresh,
    /** grant.mutateAsync({ userId, dashboard, reason }) */
    grant,
    /** revoke.mutateAsync({ userId, dashboard, reason }) */
    revoke,
  };
}

/** Find a person to grant. Searches from 2 characters; debounce the input in the view. */
export function useDashboardAccessSearch(term: string) {
  const { canEdit: canManage } = useCanEditAccess();
  const t = term.trim();
  return useQuery({
    queryKey: ['dashboard-access-search', t],
    enabled: canManage && t.length >= 2,
    staleTime: 30_000,
    queryFn: async (): Promise<DashboardAccessPerson[]> => {
      const { data, error } = await rpc('search_people_for_dashboard_access', { p_term: t });
      if (error) throw error;
      return rows(data).map((p) => ({
        id: String(p.id),
        fullName: str(p.full_name),
        phone: str(p.phone),
        email: str(p.email),
        roles: Array.isArray(p.roles) ? p.roles.map(String) : [],
      }));
    },
  });
}
