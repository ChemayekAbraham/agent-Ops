import { useEffect } from 'react';
import { Navigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '@/hooks/useAuth';
import { roleToSlug } from '@/lib/roleRoutes';
import { clearPostAuthRedirect, peekPostAuthRedirect } from '@/lib/returnPath';
import ScreenLoader from '@/components/common/ScreenLoader';

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
    return <Navigate to={roleToSlug(authRole)} replace />;
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
