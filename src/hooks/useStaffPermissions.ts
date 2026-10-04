import { useState, useEffect } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import type { AppRole } from '@/hooks/auth/types';

/**
 * Roles that bypass per-dashboard grants entirely and see everything.
 *
 *   PHASE 1 (now):   ['super_admin', 'cto']  — current behaviour, unchanged.
 *   PHASE 3 (later): []                      — access is grants-only.
 *
 * DO NOT empty this array until every dashboard key has at least one granted
 * holder in `staff_permissions`. If you empty it first, nobody can open
 * /admin/dashboard and there is no route back in through the UI — the only
 * recovery is a direct SQL insert.
 *
 * See ROLLOUT.md, step 4.
 */
const BYPASS_ROLES: AppRole[] = ['super_admin', 'cto'];

/**
 * Roles that implicitly grant their own dashboard.
 *
 * A user holding the `cfo` role can open the CFO dashboard with no row in
 * staff_permissions. This is a policy choice, not a technical requirement:
 * empty this array if the business wants an explicit grant for every
 * dashboard, including a person's own function.
 */
const SELF_ROLE_DASHBOARDS: string[] = ['ceo', 'coo', 'cfo', 'cto', 'cmo', 'crm', 'hr', 'rd'];

export function useStaffPermissions() {
  const { user, roles, loading: authLoading } = useAuth();
  const [permissions, setPermissions] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);

  const isBypassed = roles.some((r) => BYPASS_ROLES.includes(r));

  useEffect(() => {
    if (authLoading) return;

    if (!user) {
      setPermissions([]);
      setLoading(false);
      return;
    }

    if (isBypassed) {
      setPermissions(['*']);
      setLoading(false);
      return;
    }

    const roleDashboards = roles.filter((r) => SELF_ROLE_DASHBOARDS.includes(r));

    let cancelled = false;

    const fetchPermissions = async () => {
      const { data, error } = await supabase
        .from('staff_permissions')
        .select('permitted_dashboard')
        .eq('user_id', user.id)
        .is('revoked_at', null);

      if (cancelled) return;

      if (error) {
        // Fail closed. A failed permission lookup must never widen access.
        console.warn('[useStaffPermissions] grant lookup failed:', error.message);
        setPermissions([...roleDashboards]);
        setLoading(false);
        return;
      }

      const granted = (data || []).map((p: { permitted_dashboard: string }) => p.permitted_dashboard);
      setPermissions([...new Set([...roleDashboards, ...granted])]);
      setLoading(false);
    };

    setLoading(true);
    fetchPermissions();

    return () => {
      cancelled = true;
    };
  }, [user, roles, authLoading, isBypassed]);

  const hasPermission = (dashboard: string | undefined): boolean => {
    if (!dashboard) return false;
    if (isBypassed) return true;
    return permissions.includes(dashboard);
  };

  return { permissions, hasPermission, loading, isBypassed };
}
