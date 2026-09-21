// Route page for the frozen Funder dashboard backup — /dashboard/funders/bk
//
// This deliberately does NOT go through src/pages/Dashboard.tsx. That page is
// the live persona router: it reads the URL through slugToRole(), switches
// auth.role to match, auto-defaults qualified investors to /dashboard/funder
// and redirects isolated executive roles away. Routing the backup through it
// would mean the backup breaks whenever the live router changes — which is
// the one thing a backup must not do.
//
// `/dashboard/funders/bk` is not a persona slug (slugToRole returns null for
// it, since the map only knows the singular `/dashboard/funder`), so nothing
// here fights the live router for control of the URL.
//
// Access is the same as the live funder dashboard: signed in and holding the
// `supporter` role. It is a copy of a real funder's screen, so it must not be
// readable by someone who could not already see their own.

import { Suspense } from 'react';
import { Navigate } from 'react-router-dom';
import { useAuth } from '@/hooks/useAuth';
import AddRoleDialog from '@/components/AddRoleDialog';
import ScreenLoader from '@/components/common/ScreenLoader';
import { DashboardErrorBoundary } from '@/components/dashboards/DashboardErrorBoundary';
import { lazyWithRetry } from '@/lib/lazyWithRetry';

const SupporterDashboardBackup = lazyWithRetry(
  () => import('@/components/dashboards/SupporterDashboard.backup'),
);

export default function FunderDashboardBackup() {
  const { user, roles, role, loading, signOut, switchRole, addRole } = useAuth();

  if (loading) return <ScreenLoader label="Loading backup…" />;
  if (!user) return <Navigate to="/auth" replace />;

  // Same gate as the live dashboard: only a holder of the supporter role sees
  // a funder screen. No silent role grant — this is a read-only snapshot.
  if (!roles.includes('supporter')) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center p-6">
        <div className="max-w-sm text-center space-y-2">
          <h1 className="text-lg font-semibold">Funder dashboard backup</h1>
          <p className="text-sm text-muted-foreground">
            This snapshot is only available to accounts holding the Funder role.
          </p>
        </div>
      </div>
    );
  }

  return (
    <Suspense fallback={<ScreenLoader label="Loading backup…" />}>
      <DashboardErrorBoundary label="funder dashboard (backup)">
        <SupporterDashboardBackup
          user={user}
          signOut={signOut}
          currentRole={role ?? 'supporter'}
          availableRoles={roles}
          onRoleChange={switchRole}
          addRoleComponent={<AddRoleDialog availableRoles={roles} onAddRole={addRole} />}
        />
      </DashboardErrorBoundary>
    </Suspense>
  );
}
