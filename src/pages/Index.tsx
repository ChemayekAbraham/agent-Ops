import { useEffect, useState } from 'react';
import { Navigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '@/hooks/useAuth';
import { roleToSlug } from '@/lib/roleRoutes';
import { clearPostAuthRedirect, peekPostAuthRedirect } from '@/lib/returnPath';
import ScreenLoader from '@/components/common/ScreenLoader';
import { getPreferredDefaultRole } from '@/hooks/useAppPreferences';
import {
  PROXY_DASHBOARD_ROUTE, isPersonaLanding, readCachedProxyLanding, resolveProxyLanding,
} from '@/lib/proxyLanding';

/**
 * Persona landing for a signed-in user: the proxy agent dashboard for a proxy agent who has never collected rent,
 * otherwise `fallback`. A fresh cached answer redirects at once; otherwise the loader shows while it is looked up.
 */
function PersonaLanding({ userId, fallback }: { userId: string; fallback: string }) {
  const [destination, setDestination] = useState<string | null>(() => {
    const cached = readCachedProxyLanding(userId);
    return cached === null ? null : cached ? PROXY_DASHBOARD_ROUTE : fallback;
  });
  useEffect(() => {
    if (destination) return;
    let live = true;
    resolveProxyLanding(userId).then((toProxy) => {
      if (live) setDestination(toProxy ? PROXY_DASHBOARD_ROUTE : fallback);
    });
    return () => { live = false; };
  }, [destination, userId, fallback]);
  if (!destination) return <ScreenLoader />;
  return <Navigate to={destination} replace />;
}

export default function Index() {
  const { user, loading, role: authRole } = useAuth();
  const [searchParams] = useSearchParams();
  
  const ref = searchParams.get('ref');
  const role = searchParams.get('role');

  // Google/Apple sign-in returns here without ?redirect=; the deep link (e.g. a scanned asset QR page) was kept in
  // session storage before leaving. Peek during render (validated as a safe, returnable in-app path) and consume it
  // in an effect, so a double render can't lose it. The destination route still applies its own role checks.
  const postAuthPath = !loading && user ? peekPostAuthRedirect() : null;
  useEffect(() => {
    if (postAuthPath) clearPostAuthRedirect();
  }, [postAuthPath]);

  // While auth is loading: show spinner before making any redirect decision
  if (loading) {
    return (
      <ScreenLoader />
    );
  }

  // Auth finished loading — use LIVE auth state
  if (user) {
    if (postAuthPath) return <Navigate to={postAuthPath} replace />;
    // Already logged in — send them to their persona dashboard.
    // authRole may not be set yet on cold load; helper falls back to /tenant.
    // A persona landing goes to the proxy dashboard for a proxy agent with no collections, unless the user picked
    // a home screen in Settings. Staff roles keep their own dashboards.
    if (isPersonaLanding(authRole) && getPreferredDefaultRole() === 'auto') {
      return <PersonaLanding userId={user.id} fallback={roleToSlug(authRole)} />;
    }
    return <Navigate to={roleToSlug(authRole)} replace />;
  }

  // Not logged in after a failed Google/Apple sign-in: the provider returns to the
  // site root with ?error= / #error=. Hand it to /auth, which records and shows it,
  // instead of dropping it on /welcome.
  const hash = typeof window !== 'undefined' ? window.location.hash : '';
  if (searchParams.get('error') || /[#&]error=/.test(hash)) {
    return <Navigate to={{ pathname: '/auth', search: `?${searchParams.toString()}`, hash }} replace />;
  }

  // Not logged in — send referral/role links to auth
  if (ref || role) {
    const params = new URLSearchParams();
    if (ref) params.set('ref', ref);
    if (role) params.set('role', role);
    return <Navigate to={`/auth?${params.toString()}`} replace />;
  }

  return <Navigate to="/welcome" replace />;
}
