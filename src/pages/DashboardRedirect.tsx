import { useEffect } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { useAuth, type AppRole } from '@/hooks/useAuth';
import { roleToSlug, slugToRole } from '@/lib/roleRoutes';
import { getPreferredDefaultRole, isAgentAutoDefaultDisabled } from '@/hooks/useAppPreferences';
import { supabase } from '@/integrations/supabase/client';
import { fetchServerRoutingPrefs } from '@/lib/routingPrefsServer';
import { Loader2 } from 'lucide-react';
import ScreenLoader from '@/components/common/ScreenLoader';
import { toast } from 'sonner';

/**
 * Catch-all redirect for the legacy `/dashboard` URL.
 *
 * Old home-screen icons, stale SMS/email links, and bookmarks may still hit
 * the bare `/dashboard` path — and users may have lost a role since the link
 * was created. We resolve the *currently held* role and forward to the
 * matching `/dashboard/{role}` slug. Any requested role we cannot honour
 * (stale `auth.role`, expired `?role=` hint, or a `/dashboard/<bad-slug>`
 * URL the user no longer has access to) falls through to `/select-role`
 * rather than landing on a broken persona screen.
 */
export default function DashboardRedirect() {
  const { user, role, roles, loading, rolesResolved } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  // Allow `?role=agent` style hints AND `/dashboard/<slug>` path hints
  // to override the cached default role — but only if the user still
  // holds that role.
  const queryHint = new URLSearchParams(location.search).get('role') as AppRole | null;
  const pathHint = slugToRole(location.pathname); // null for bare `/dashboard`

  // Detect `/dashboard/<unknown-slug>` so we can route those users to the
  // role picker rather than silently dropping them on their default
  // dashboard. A bare `/dashboard` (no second segment) is NOT considered
  // unknown — it's the legacy entry point and should fall through.
  const segments = location.pathname.split('/').filter(Boolean);
  const hasUnknownPathSlug =
    segments[0] === 'dashboard' && segments.length > 1 && pathHint === null;

  useEffect(() => {
    if (loading) return;
    if (!user) {
      navigate('/auth', { replace: true });
      return;
    }

    // Small helper: surface the routing decision so users understand
    // why they landed on a particular dashboard.
    const explain = (target: AppRole, reason: string) => {
      try {
        toast.message(`Opened ${target} dashboard`, {
          description: reason,
          duration: 4500,
        });
      } catch {}
    };

    // No roles at all → onboarding picker. This is the lost-roles case.
    //
    // Only act on a DEFINITIVE empty answer. A transient failure right after
    // sign-in (token refresh in flight, slow first request) used to land users
    // with full roles on the "Dashboard not available" picker. While the role
    // lookup is unresolved we hold on the loading screen; if it never resolves
    // we fall through to the picker after a bounded wait.
    if (roles.length === 0) {
      if (rolesResolved) {
        navigate('/select-role', { replace: true, state: { reason: 'no-roles' } });
        return;
      }
      const unresolvedTimer = setTimeout(() => {
        navigate('/select-role', { replace: true, state: { reason: 'no-roles' } });
      }, 6000);
      return () => clearTimeout(unresolvedTimer);
    }

    // Detect whether the local prefs file actually has explicit routing
    // entries. If it doesn't (fresh device, cleared storage, private mode,
    // etc.) we'll consult the server before falling through to the
    // auto-agent rule, so the user's choice still applies across devices.
    const hasLocalRoutingPrefs = (() => {
      try {
        const raw = localStorage.getItem('welile_app_preferences');
        if (!raw) return false;
        const parsed = JSON.parse(raw);
        return 'defaultRole' in parsed || 'disableAgentAutoDefault' in parsed;
      } catch { return false; }
    })();

    // Pick the first hint the user actually still holds.
    // Priority: explicit URL/query hint → user's chosen default →
    // "agent if they have ever posted a rent request" auto-rule → cached auth.role.
    const preferred = getPreferredDefaultRole();
    const preferredRole: AppRole | null =
      preferred !== 'auto' ? (preferred as AppRole) : null;

    // Honor explicit hints / user-chosen default first.
    const explicit: Array<AppRole | null> = [pathHint, queryHint, preferredRole];
    const explicitHonored = explicit.find((c): c is AppRole => !!c && roles.includes(c));
    if (explicitHonored) {
      const why =
        explicitHonored === pathHint
          ? 'You opened this URL directly.'
          : explicitHonored === queryHint
            ? 'Followed the role hint in your link.'
            : 'Matches your chosen home screen in Settings.';
      explain(explicitHonored, why);
      navigate(roleToSlug(explicitHonored), { replace: true });
      return;
    }

    // A specific persona was requested but the user no longer has it
    // (revoked access, expired link) OR the URL contains an unknown
    // persona slug like `/dashboard/foo`. Send them to the role picker.
    if (pathHint || queryHint || hasUnknownPathSlug) {
      const requestedSlug = hasUnknownPathSlug
        ? location.pathname
        : queryHint
          ? `/dashboard/${queryHint === 'supporter' ? 'funder' : queryHint}`
          : location.pathname;
      navigate('/select-role', {
        replace: true,
        state: {
          reason: hasUnknownPathSlug ? 'unknown-slug' : 'role-not-held',
          requestedSlug,
        },
      });
      return;
    }

    // Auto rule: if the user holds the 'agent' role AND has ever posted a
    // rent request (as agent_id), default them to the agent dashboard.
    // Cached per-user in localStorage so we only hit the DB once.
    const cacheKey = `welile_has_posted_rent_request_${user.id}`;
    const goAgent = () => {
      explain('agent', 'You hold the agent role and have posted a rent request before. Turn this off in Settings → Roles → Home Screen.');
      navigate(roleToSlug('agent'), { replace: true });
    };
    const fallback = () => {
      const honored = role && roles.includes(role) ? role : roles[0];
      const why = honored === role
        ? 'Continuing where you last left off.'
        : `Defaulted to your first available role (${honored}).`;
      explain(honored, why);
      navigate(roleToSlug(honored), { replace: true });
    };

    // Server-side fallback: if no local routing prefs are saved, ask the
    // user's profile what they chose previously (synced across devices).
    // Race with a short timeout so we never hang the redirect.
    const applyServerPrefsThenDecide = async () => {
      const server = await fetchServerRoutingPrefs(user.id, 1200);
      if (server) {
        if (server.defaultRole && server.defaultRole !== 'auto'
            && roles.includes(server.defaultRole as AppRole)) {
          const target = server.defaultRole as AppRole;
          explain(target, 'Synced from your saved choice on another device.');
          navigate(roleToSlug(target), { replace: true });
          return true;
        }
        if (server.disableAgentAutoDefault) {
          // User opted out elsewhere — skip the agent rule.
          fallback();
          return true;
        }
      }
      return false;
    };

    if (!hasLocalRoutingPrefs) {
      applyServerPrefsThenDecide().then((handled) => {
        if (handled) return;
        runAgentAutoRule();
      });
      return;
    }

    runAgentAutoRule();

    function runAgentAutoRule() {
    if (roles.includes('agent') && !isAgentAutoDefaultDisabled()) {
      let cached: string | null = null;
      try { cached = localStorage.getItem(cacheKey); } catch {}
      if (cached === '1') { goAgent(); return; }
      if (cached === '0') { fallback(); return; }

      // Unknown — check once, then route. Don't block UI longer than 1.5s.
      let settled = false;
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        fallback();
      }, 1500);
      supabase
        .from('rent_requests')
        .select('id', { head: true, count: 'exact' })
        .eq('agent_id', user.id)
        .limit(1)
        .then(({ count, error }) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          const has = !error && (count ?? 0) > 0;
          try { localStorage.setItem(cacheKey, has ? '1' : '0'); } catch {}
          if (has) goAgent(); else fallback();
        });
      return;
    }

    fallback();
    }
  }, [loading, user, role, roles, rolesResolved, pathHint, queryHint, hasUnknownPathSlug, navigate]);

  // While auth resolves, show the same skeleton the dashboard uses so
  // there is no flash of empty content.
  if (!loading && !user) return <Navigate to="/auth" replace />;
  return (
    <ScreenLoader />
  );
}
