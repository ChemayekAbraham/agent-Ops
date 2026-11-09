import { lazy, Suspense } from 'react';
import { useLocation } from 'react-router-dom';
import { useAuth } from '@/hooks/useAuth';

const SignageInstallationPrompt = lazy(() => import('./SignageInstallationPrompt').then((m) => ({ default: m.SignageInstallationPrompt })));

/** Only signed-in agents on their dashboards check for signage installations awaiting photos. */
export function AgentSignageInstallationGate() {
  const { user, enabledRoles } = useAuth();
  const { pathname } = useLocation();
  if (!user || !enabledRoles?.includes('agent' as never) || !pathname.startsWith('/dashboard')) return null;
  return <Suspense fallback={null}><SignageInstallationPrompt /></Suspense>;
}
