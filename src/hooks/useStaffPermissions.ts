import { useState, useEffect, useRef } from 'react';
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

/**
 * The last permission answer for each signed-in person, kept for the life of the page.
 *
 * Every screen that asks "what may this person open?" used to start from "loading" each time it was built or the
 * sign-in object changed, and the dashboards that wrap everything replaced their whole contents with a loading
 * page until the answer came back. With a held answer, a screen that is built again (or asked again in the
 * background) starts from what was last known and quietly swaps in the fresh answer. The loading page is only
 * for a person we have no answer for yet. A change of roles asks again in the background; until it answers, the
 * screen keeps the last answer for that person.
 */
const answers = new Map<string, string[]>();

/** For tests and sign-out: forget every held answer. */
export function clearStaffPermissionAnswers(): void {
  answers.clear();
}

export function useStaffPermissions() {
  const { user, roles, loading: authLoading } = useAuth();
  const userId = user?.id ?? null;
  // A stable text for the role list, so a new array with the same roles is not a change.
  const rolesKey = [...roles].sort().join(',');
  const isBypassed = roles.some((r) => BYPASS_ROLES.includes(r));

  const held = userId ? answers.get(userId) : undefined;
  const [permissions, setPermissions] = useState<string[]>(held ?? []);
  // Loading means "no answer yet" only. A background refresh never turns it back on.
  const [loading, setLoading] = useState(!held);
  // Which person the permissions on screen belong to.
  const shownFor = useRef<string | null>(held && userId ? userId : null);

  useEffect(() => {
    if (authLoading) return;

    if (!userId) {
      // signed out: forget every held answer
      answers.clear();
      shownFor.current = null;
      setPermissions((prev) => (prev.length === 0 ? prev : []));
      setLoading(false);
      return;
    }

    if (isBypassed) {
      shownFor.current = userId;
      setPermissions(['*']);
      setLoading(false);
      return;
    }

    const key = userId;
    const roleDashboards = roles.filter((r) => SELF_ROLE_DASHBOARDS.includes(r));
    const heldNow = answers.get(key);

    // Show what is already known at once; only a person with no answer at all waits on the loading page.
    if (heldNow) {
      if (shownFor.current !== key) {
        shownFor.current = key;
        setPermissions(heldNow);
      }
      setLoading(false);
    } else {
      // no answer for this person yet: never show the previous person's grants while waiting
      shownFor.current = null;
      setPermissions((prev) => (prev.length === 0 ? prev : []));
      setLoading(true);
    }

    let cancelled = false;

    const fetchPermissions = async () => {
      const { data, error } = await supabase
        .from('staff_permissions')
        .select('permitted_dashboard')
        .eq('user_id', userId)
        .is('revoked_at', null);

      if (cancelled) return;

      if (error) {
        console.warn('[useStaffPermissions] grant lookup failed:', error.message);
        // A refresh that fails keeps the answer already on screen: it was true a moment ago, and dropping it would
        // throw an open dashboard away over a network blip. With no answer at all, fail closed as before: a failed
        // lookup must never widen access.
        if (!answers.get(key)) {
          shownFor.current = key;
          setPermissions([...roleDashboards]);
        }
        setLoading(false);
        return;
      }

      const granted = (data || []).map((p: { permitted_dashboard: string }) => p.permitted_dashboard);
      const next = [...new Set([...roleDashboards, ...granted])];
      const previous = answers.get(key);
      answers.set(key, next);
      shownFor.current = key;
      // The same answer keeps the same array, so nothing that depends on it starts over.
      setPermissions((prev) => (sameList(prev, next) ? prev : previous && sameList(previous, next) ? previous : next));
      setLoading(false);
    };

    fetchPermissions();

    return () => {
      cancelled = true;
    };
  }, [userId, rolesKey, authLoading, isBypassed]);

  const hasPermission = (dashboard: string | undefined): boolean => {
    if (!dashboard) return false;
    if (isBypassed) return true;
    return permissions.includes(dashboard);
  };

  return { permissions, hasPermission, loading, isBypassed };
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((x) => set.has(x));
}
