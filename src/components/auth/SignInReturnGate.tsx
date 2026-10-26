import { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '@/hooks/useAuth';

/**
 * Sends a signed-out visitor to /auth with this page as `?redirect=`, so a deep link (e.g. a scanned asset QR code)
 * lands back here after sign-in. It grants nothing: wrap a RoleGuard, which still decides access once signed in.
 * /auth only honours in-app paths (`safeInternalPath`).
 */
export default function SignInReturnGate({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  const location = useLocation();
  if (!loading && !user) {
    const path = `${location.pathname}${location.search}`;
    return <Navigate to={`/auth?redirect=${encodeURIComponent(path)}`} replace />;
  }
  return <>{children}</>;
}
